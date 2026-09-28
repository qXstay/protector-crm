import { Prisma, PrismaClient } from "@prisma/client";

import { resolveRuntimeDatasourceUrl } from "@/server/db/datasource-url";
import { prisma, withPrismaClient } from "@/server/db/prisma";
import { runKkmDemoHelper } from "@/server/services/kkm-demo-helper";

import { realNowMs, runAtDemoTime, setDemoClockOffset } from "./clock";
import { DB_CLOCK_BYPASS_SQL, writeDemoDbClockOffset } from "./db-clock";
import { runDemoDdl } from "./ddl";
import { setWorldSwapInProgress } from "./swap-state";
import { currentWorkdayClockOffset } from "./workday-clock";
import { withDemoLease } from "./lock";
import { DEMO_BRANCHES, demoAdminForBranch, writeDemoFoundation, writeDemoKkmDevices } from "./foundation";
import {
  addDays,
  dayKeyOf,
  DemoHistoryGenerator,
  localMoment,
  type GenerationProgress,
  type TodayPlan,
} from "./generator";

/**
 * Мир витрины: сборка демо-данных, их снимок и быстрый возврат к снимку.
 *
 * Мир детерминирован по дате: зерно случайности — день сборки, момент отсчёта
 * истории — утро этого дня (`worldAnchor`), поэтому пересборка в течение дня
 * даёт тот же день, двигается только граница «сделано / запланировано».
 *
 * Сборка атомарна: история пишется функциями самой системы, но в отдельную
 * схему `showcase_demo_build` — внутри `withPrismaClient` репозитории получают
 * клиент этой схемы, а посетители всё это время работают со старым миром.
 * Там же сохраняется утренний снимок (`showcase_demo_snapshot`) и проводится
 * сегодняшний день до текущей минуты; потом одна транзакция подменяет данные
 * в `public` целиком. Посетитель видит либо старый мир, либо новый — никогда
 * не полупустой. Возврат к снимку («Сбросить демо», тихая пересборка) идёт
 * тем же путём: снимок → схема сборки → день до текущей минуты → подмена.
 * Одновременно идёт только одна пересборка: аренда в базе (`lock.ts`).
 *
 * Служебные таблицы витрины живут в своих схемах (`showcase_demo`,
 * `showcase_demo_snapshot`, `showcase_demo_build`), которых нет в миграциях
 * Prisma: `migrate deploy` их не видит и не трогает.
 */

export const HISTORY_DAYS = Number(process.env.SHOWCASE_DEMO_HISTORY_DAYS) || 75;
export const FUTURE_DAYS = 14;
const DEMO_SCHEMA = "showcase_demo";
const SNAPSHOT_SCHEMA = "showcase_demo_snapshot";
const SNAPSHOT_NEXT_SCHEMA = "showcase_demo_snapshot_next";
const BUILD_SCHEMA = "showcase_demo_build";
// Версия генератора мира: смена пересобирает мир при старте (как смена схемы).
// 6 — вымышленные номера касс и ИНН, регионы и коды телефонов со всей
// страны, пояс без названий городов; 7 — телефоны мастеров тоже с
// федеральными кодами; 8 — записи только за последние четыре недели истории;
// 9 — ровная история с недельным ритмом (без «сезона»), сохранённые
// настройки формулы зарплаты; 10 — паузы первого поста тоже по дню недели;
// 11 — оплаты без чека только вчера и сегодня; 12 — первый пост снова без
// пауз (на точке всегда есть машина в работе), ритм недели — на втором посту.
const WORLD_VERSION = 12;
const WORLD_LEASE = "world";

/**
 * Момент отсчёта мира — 07:00 по времени точек в день сборки: до открытия и
 * до ежедневной пересборки (08:00, это 06:00 по Москве). От него, а не от
 * минуты сборки, считаются даты записей и визитов.
 */
export function worldAnchor(now: Date) {
  return localMoment(dayKeyOf(now), 7 * 60);
}

/** Таблицы, которые демо не трогает. */
const KEEP_TABLES = new Set(["_prisma_migrations", "Session", "Migration016DeferredIdentity", "Migration016VehicleDedupBackup"]);

type TableInfo = { name: string; columns: string[] };

async function listDataTables(): Promise<TableInfo[]> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; ordinal_position: number }>>`
    SELECT c.table_name, c.column_name, c.ordinal_position
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position`;
  const tables = new Map<string, string[]>();
  for (const row of rows) {
    if (KEEP_TABLES.has(row.table_name)) continue;
    const columns = tables.get(row.table_name) ?? [];
    columns.push(row.column_name);
    tables.set(row.table_name, columns);
  }
  return [...tables.entries()].map(([name, columns]) => ({ name, columns }));
}

/** Порядок вставки: сначала таблицы, на которые ссылаются. */
async function orderByForeignKeys(tables: TableInfo[]): Promise<TableInfo[]> {
  const edges = await prisma.$queryRaw<Array<{ child: string; parent: string; column_name: string }>>`
    SELECT tc.table_name AS child, ccu.table_name AS parent, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`;
  const names = new Set(tables.map((table) => table.name));
  const dependsOn = new Map<string, Set<string>>();
  for (const table of tables) dependsOn.set(table.name, new Set());
  for (const edge of edges) {
    // Цикл «заказ ↔ корректировка»: в снимке `currentAmendmentId` пуст.
    if (edge.child === "Order" && edge.column_name === "currentAmendmentId") continue;
    if (edge.child === edge.parent || !names.has(edge.child) || !names.has(edge.parent)) continue;
    dependsOn.get(edge.child)!.add(edge.parent);
  }
  const ordered: TableInfo[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter(
      (table) => !placed.has(table.name) && [...dependsOn.get(table.name)!].every((parent) => placed.has(parent)),
    );
    if (ready.length === 0) throw new Error("Не удалось упорядочить таблицы по внешним ключам.");
    for (const table of ready) {
      ordered.push(table);
      placed.add(table.name);
    }
  }
  return ordered;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Один раз на процесс; одновременные вызовы ждут одного и того же создания. */
let demoSchemasReady: Promise<void> | null = null;

function ensureDemoSchemas() {
  demoSchemasReady ??= runDemoDdl([
    `CREATE SCHEMA IF NOT EXISTS ${DEMO_SCHEMA}`,
    `CREATE TABLE IF NOT EXISTS ${DEMO_SCHEMA}.state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS ${DEMO_SCHEMA}.kept_sessions (LIKE public."Session" INCLUDING DEFAULTS)`,
  ]).catch((error: unknown) => {
    demoSchemasReady = null;
    throw error;
  });
  return demoSchemasReady;
}

export async function readDemoState<T>(key: string): Promise<T | null> {
  await ensureDemoSchemas();
  const rows = await prisma.$queryRawUnsafe<Array<{ value: T }>>(
    `SELECT value FROM ${DEMO_SCHEMA}.state WHERE key = $1`,
    key,
  );
  return rows[0]?.value ?? null;
}

export async function writeDemoState(key: string, value: unknown) {
  await ensureDemoSchemas();
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${DEMO_SCHEMA}.state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    key,
    JSON.stringify(value),
  );
}

async function migrationsFingerprint() {
  const rows = await prisma.$queryRaw<Array<{ count: bigint; last: string | null }>>`
    SELECT count(*) AS count, max(migration_name) AS last FROM public._prisma_migrations WHERE finished_at IS NOT NULL`;
  return `${rows[0]?.count ?? 0}:${rows[0]?.last ?? ""}:v${WORLD_VERSION}`;
}

/** Сессии посетителей переживают сброс: демо-сотрудники те же, id те же. */
async function keepSessions(tx: Prisma.TransactionClient) {
  await tx.$executeRawUnsafe(`TRUNCATE ${DEMO_SCHEMA}.kept_sessions`);
  await tx.$executeRawUnsafe(`INSERT INTO ${DEMO_SCHEMA}.kept_sessions SELECT * FROM public."Session"`);
}

async function returnSessions(tx: Prisma.TransactionClient) {
  await tx.$executeRawUnsafe(`
    INSERT INTO public."Session"
    SELECT k.* FROM ${DEMO_SCHEMA}.kept_sessions k
    WHERE EXISTS (SELECT 1 FROM public."User" u WHERE u.id = k."userId" AND u."isActive")
      AND EXISTS (SELECT 1 FROM public."Employee" e WHERE e.id = k."employeeId")
      AND EXISTS (SELECT 1 FROM public."EmployeeBranchAccess" a WHERE a."employeeId" = k."employeeId" AND a."branchId" = k."currentBranchId")
      AND k."expiresAt" > now()
    ON CONFLICT DO NOTHING`);
  // Роль сессии — как у сотрудника сейчас (посетитель мог её сменить до сброса).
  await tx.$executeRawUnsafe(`
    UPDATE public."Session" s SET "roleIdSnapshot" = e."roleId"
    FROM public."Employee" e WHERE e.id = s."employeeId" AND s."roleIdSnapshot" <> e."roleId"`);
}

/**
 * Прежний мир стирается `DELETE`, а не `TRUNCATE`: TRUNCATE берёт на таблицы
 * ACCESS EXCLUSIVE, и всю подмену (на сервере витрин — около 20 с) любой
 * запрос посетителя ждал. DELETE в той же транзакции чтение не держит:
 * посетитель до фиксации видит прежний мир, после — новый, полупустого
 * состояния по-прежнему нет. Таблицы — от дочерних к родительским (`tables`
 * упорядочены от родительских); ссылки таблицы на саму себя (RESTRICT
 * проверяется сразу, построчно) сначала обнуляются. Сессии, как и при
 * TRUNCATE … CASCADE, уходят каскадом и возвращаются `returnSessions`.
 */
async function wipeDataTables(tx: Prisma.TransactionClient, tables: TableInfo[]) {
  const selfReferences = await tx.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = kcu.table_name`;
  const names = new Set(tables.map((table) => table.name));
  for (const reference of selfReferences) {
    if (!names.has(reference.table_name)) continue;
    await tx.$executeRawUnsafe(
      `UPDATE public.${quote(reference.table_name)} SET ${quote(reference.column_name)} = NULL WHERE ${quote(reference.column_name)} IS NOT NULL`,
    );
  }
  for (const table of [...tables].reverse()) {
    await tx.$executeRawUnsafe(`DELETE FROM public.${quote(table.name)}`);
  }
}

/**
 * Время, которое проставляет сама база (`@default(now())`, `@updatedAt`), —
 * это время сборки. Переносим его к событиям истории, иначе журнал смены и
 * очередь чеков показали бы «сегодня, 03:12» у заказов прошлого месяца.
 */
async function alignDatabaseTimestamps(bookingTimes: Array<{ groupId: string; at: number }>) {
  const statements = [
    `UPDATE "Payment" SET "createdAt" = "paidAt", "updatedAt" = "paidAt"`,
    `UPDATE "OrderPayrollAccrual" a SET "createdAt" = p."paidAt", "updatedAt" = p."paidAt" FROM "Payment" p WHERE p.id = a."paymentId"`,
    `UPDATE "OrderPayrollPayout" o SET "createdAt" = a."createdAt" FROM "OrderPayrollAccrual" a WHERE a.id = o."accrualId"`,
    `UPDATE "Shift" SET "createdAt" = "openedAt", "updatedAt" = COALESCE("closedAt", "openedAt")`,
    `UPDATE "ShiftStaff" st SET "createdAt" = s."openedAt", "updatedAt" = COALESCE(s."closedAt", s."openedAt") FROM "Shift" s WHERE s.id = st."shiftId"`,
    `UPDATE "OrderLine" l SET "createdAt" = o."createdAt", "updatedAt" = o."updatedAt" FROM "Order" o WHERE o.id = l."orderId"`,
    `UPDATE "OrderExecutor" e SET "createdAt" = o."createdAt", "updatedAt" = o."updatedAt" FROM "Order" o WHERE o.id = e."orderId"`,
    `UPDATE "Client" SET "createdAt" = COALESCE("registeredAt", "createdAt"), "updatedAt" = COALESCE("registeredAt", "updatedAt")`,
    `UPDATE "Vehicle" v SET "createdAt" = c."createdAt", "updatedAt" = c."createdAt" FROM "Client" c WHERE c.id = v."clientId" AND v."createdAt" > now() - interval '6 hours'`,
    `UPDATE "StorageRecord" SET "createdAt" = "acceptedAt", "updatedAt" = COALESCE("releasedAt", "acceptedAt")`,
    `UPDATE "CashCollection" SET "createdAt" = "collectedAt"`,
    `UPDATE "KkmOperation" k SET "createdAt" = COALESCE((SELECT min(p."paidAt") FROM "KkmOperationPayment" kp JOIN "Payment" p ON p.id = kp."paymentId" WHERE kp."operationId" = k.id), o."updatedAt"), "updatedAt" = COALESCE(k."completedAt", o."updatedAt") FROM "Order" o WHERE o.id = k."orderId"`,
    `UPDATE "KkmOperationEvent" ev SET "createdAt" = CASE WHEN ev."eventType" = 'created' THEN k."createdAt" ELSE COALESCE(k."completedAt", k."createdAt") + interval '2 seconds' END FROM "KkmOperation" k WHERE k.id = ev."operationId"`,
    // Журнал: у событий смены и оплат время есть в самом событии.
    `UPDATE "AuditEvent" SET "createdAt" = ("payloadJson"->>'dateTime')::timestamptz WHERE "payloadJson" ? 'dateTime' AND ("payloadJson"->>'dateTime') ~ '^\\d{4}-\\d{2}-\\d{2}T'`,
    `UPDATE "AuditEvent" a SET "createdAt" = o."updatedAt" FROM "Order" o WHERE a."entityType" = 'order' AND a."entityId" = o.id AND a."createdAt" > now() - interval '6 hours'`,
    `UPDATE "AuditEvent" a SET "createdAt" = s."openedAt" FROM "Shift" s WHERE a."entityType" = 'shift' AND a."entityId" = s.id AND a."createdAt" > now() - interval '6 hours'`,
  ];
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }
  for (let index = 0; index < bookingTimes.length; index += 500) {
    const chunk = bookingTimes.slice(index, index + 500);
    const values = chunk.map((_, position) => `($${position * 2 + 1}, $${position * 2 + 2}::timestamptz)`).join(", ");
    const params = chunk.flatMap((entry) => [entry.groupId, new Date(entry.at).toISOString()]);
    await prisma.$executeRawUnsafe(
      `UPDATE "Booking" b SET "createdAt" = v.at, "updatedAt" = v.at FROM (VALUES ${values}) AS v(group_id, at) WHERE b."groupId" = v.group_id`,
      ...params,
    );
  }
}

/* ───────────────────────────────────────────── схемы сборки и снимка */

type EnumInfo = { name: string; labels: string[] };
type EnumColumn = { table: string; column: string; type: string };

/** Перечисления схемы `public` и их столбцы (в Prisma это `enum`). */
async function describeEnums(tables: TableInfo[]) {
  const enums = await prisma.$queryRaw<Array<{ name: string; labels: string[] }>>`
    SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname`;
  const names = new Set(enums.map((item) => item.name));
  const tableNames = new Set(tables.map((table) => table.name));
  const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; udt_name: string }>>`
    SELECT table_name, column_name, udt_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'USER-DEFINED'`;
  return {
    enums: enums as EnumInfo[],
    enumColumns: columns
      .filter((column) => names.has(column.udt_name) && tableNames.has(column.table_name))
      .map((column) => ({ table: column.table_name, column: column.column_name, type: column.udt_name })) as EnumColumn[],
  };
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Список столбцов для SELECT: перечисления — через текст в тип схемы `targetSchema`. */
function selectList(table: TableInfo, enumColumns: EnumColumn[], targetSchema: string) {
  return table.columns
    .map((column) => {
      const enumColumn = enumColumns.find((item) => item.table === table.name && item.column === column);
      return enumColumn ? `${quote(column)}::text::${targetSchema}.${quote(enumColumn.type)}` : quote(column);
    })
    .join(", ");
}

/**
 * Пустая схема сборки с теми же таблицами, что `public` (значения по
 * умолчанию, ограничения, индексы; без внешних ключей — они сборке не нужны),
 * и своими копиями перечислений: клиент Prisma схемы сборки приводит к ним.
 */
async function prepareBuildSchema(tables: TableInfo[], enums: EnumInfo[], enumColumns: EnumColumn[]) {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${BUILD_SCHEMA} CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${BUILD_SCHEMA}`);
  for (const item of enums) {
    await prisma.$executeRawUnsafe(
      `CREATE TYPE ${BUILD_SCHEMA}.${quote(item.name)} AS ENUM (${item.labels.map(literal).join(", ")})`,
    );
  }
  for (const table of tables) {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${BUILD_SCHEMA}.${quote(table.name)} (LIKE public.${quote(table.name)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES INCLUDING GENERATED INCLUDING IDENTITY)`,
    );
  }
  for (const column of enumColumns) {
    const rows = await prisma.$queryRaw<Array<{ column_default: string | null }>>`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = ${BUILD_SCHEMA} AND table_name = ${column.table} AND column_name = ${column.column}`;
    const target = `${BUILD_SCHEMA}.${quote(column.table)}`;
    const enumType = `${BUILD_SCHEMA}.${quote(column.type)}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE ${target} ALTER COLUMN ${quote(column.column)} DROP DEFAULT`);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ${target} ALTER COLUMN ${quote(column.column)} TYPE ${enumType} USING ${quote(column.column)}::text::${enumType}`,
    );
    const defaultLabel = rows[0]?.column_default?.match(/^'((?:[^']|'')*)'::/)?.[1];
    if (defaultLabel !== undefined) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE ${target} ALTER COLUMN ${quote(column.column)} SET DEFAULT '${defaultLabel}'::${enumType}`,
      );
    }
  }
}

/** Клиент Prisma, который пишет в схему сборки. */
function createBuildClient() {
  const base =
    resolveRuntimeDatasourceUrl(process.env.DATABASE_URL, process.env.SHOWCASE_DB_JIT) ?? process.env.DATABASE_URL;
  if (!base) throw new Error("Нет DATABASE_URL для сборки демо-мира.");
  const url = new URL(base);
  url.searchParams.set("schema", BUILD_SCHEMA);
  url.searchParams.set("connection_limit", "3");
  return new PrismaClient({ datasourceUrl: url.toString(), log: ["error"] });
}

/** Утренний снимок мира из схемы сборки: перечисления — к типам `public`. */
async function snapshotFromBuild(tables: TableInfo[], enumColumns: EnumColumn[]) {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SNAPSHOT_NEXT_SCHEMA} CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${SNAPSHOT_NEXT_SCHEMA}`);
  for (const table of tables) {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${SNAPSHOT_NEXT_SCHEMA}.${quote(table.name)} AS SELECT ${selectList(table, enumColumns, "public")} FROM ${BUILD_SCHEMA}.${quote(table.name)}`,
    );
  }
}

async function promoteSnapshot() {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA} CASCADE`),
    prisma.$executeRawUnsafe(`ALTER SCHEMA ${SNAPSHOT_NEXT_SCHEMA} RENAME TO ${SNAPSHOT_SCHEMA}`),
  ]);
}

/** Схема сборки из снимка — для сброса и тихой пересборки. */
async function buildFromSnapshot(tables: TableInfo[], enumColumns: EnumColumn[]) {
  for (const table of tables) {
    const columns = table.columns.map(quote).join(", ");
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${BUILD_SCHEMA}.${quote(table.name)} (${columns}) SELECT ${selectList(table, enumColumns, BUILD_SCHEMA)} FROM ${SNAPSHOT_SCHEMA}.${quote(table.name)}`,
    );
  }
}

/**
 * Подмена мира одной транзакцией: `public` получает данные схемы сборки.
 * Пока транзакция идёт, посетители читают прежний мир (DELETE чтение не
 * держит), после фиксации — новый; полупустого состояния снаружи не бывает.
 */
async function swapBuildIntoLive(tables: TableInfo[], enumColumns: EnumColumn[]) {
  setWorldSwapInProgress(true);
  try {
    await swapTransaction(tables, enumColumns);
  } finally {
    setWorldSwapInProgress(false);
  }
}

async function swapTransaction(tables: TableInfo[], enumColumns: EnumColumn[]) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(DB_CLOCK_BYPASS_SQL);
      await keepSessions(tx);
      await wipeDataTables(tx, tables);
      for (const table of tables) {
        const columns = table.columns.map(quote).join(", ");
        await tx.$executeRawUnsafe(
          `INSERT INTO public.${quote(table.name)} (${columns}) SELECT ${selectList(table, enumColumns, "public")} FROM ${BUILD_SCHEMA}.${quote(table.name)}`,
        );
      }
      await returnSessions(tx);
    },
    { timeout: 180_000, maxWait: 30_000 },
  );
}

/** Сдвиг часов демо-мира — серверу и базе, сразу после подмены мира. */
async function applyDemoClockOffset(clockOffsetMs: number) {
  setDemoClockOffset(clockOffsetMs);
  await writeDemoDbClockOffset(clockOffsetMs);
}

async function dropBuildSchema() {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${BUILD_SCHEMA} CASCADE`).catch(() => undefined);
}

export type DemoWorldMeta = {
  dayKey: string;
  builtAt: string;
  /** Сдвиг часов демо-мира, с которым мир собран (`workday-clock.ts`). */
  clockOffsetMs?: number;
  fingerprint: string;
  stats: Record<string, number>;
  failures: string[];
  durationMs: number;
};

export class DemoWorldBusyError extends Error {
  constructor() {
    super("Данные уже обновляются.");
  }
}

/**
 * Полная сборка демо-мира на сегодня: минута-две в фоне, посетители всё это
 * время видят прежний мир. Одна сборка за раз — иначе `DemoWorldBusyError`.
 */
export async function buildDemoWorld(options: { now?: Date; clockOffsetMs?: number; onProgress?: GenerationProgress } = {}) {
  await ensureDemoSchemas();
  const result = await withDemoLease(WORLD_LEASE, () => buildWorldUnderLease(options));
  if (!result.ran) throw new DemoWorldBusyError();
  return result.value;
}

async function buildWorldUnderLease(options: { now?: Date; clockOffsetMs?: number; onProgress?: GenerationProgress }) {
  const startedAt = realNowMs();
  // Часы демо-мира: мир собирается «на» сдвинутое «сейчас» (ночью — рабочий
  // день точек), сдвиг включается вместе с подменой мира.
  const clockOffsetMs =
    options.clockOffsetMs ?? (options.now ? options.now.getTime() - startedAt : currentWorkdayClockOffset(startedAt));
  const now = options.now ?? new Date(startedAt + clockOffsetMs);
  const demoNow = () => new Date(realNowMs() + clockOffsetMs);
  const anchor = worldAnchor(now);
  const tables = await orderByForeignKeys(await listDataTables());
  const { enums, enumColumns } = await describeEnums(tables);

  options.onProgress?.(0.01, "Основа: точки, роли, сотрудники");
  await prepareBuildSchema(tables, enums, enumColumns);
  const client = createBuildClient();
  try {
    const bookingTimes: Array<{ groupId: string; at: number }> = [];
    const generator = new DemoHistoryGenerator({
      now: anchor,
      historyDays: HISTORY_DAYS,
      futureDays: FUTURE_DAYS,
      onProgress: options.onProgress,
      onBooking: (groupId, at) => bookingTimes.push({ groupId, at }),
    });

    const todayPlan = await withPrismaClient(client, async () => {
      await writeDemoFoundation(prisma, anchor);
      const historyStart = localMoment(addDays(dayKeyOf(anchor), -HISTORY_DAYS - 1), 8 * 60);
      await writeDemoKkmDevices(prisma, historyStart);
      await generator.loadCatalog();
      await generator.seedClientBase();
      await generator.generateHistory();
      options.onProgress?.(0.92, "Записи на ближайшие дни");
      const plan = generator.planToday();
      await generator.generateFutureBookings(plan);
      await generator.markRecentOrdersForDeletion();
      options.onProgress?.(0.95, "Сверка времени и снимок");
      await alignDatabaseTimestamps(bookingTimes);
      await prisma.kkmDevice.updateMany({ data: { lastHeartbeatAt: now } });
      await prisma.$executeRawUnsafe(
        `UPDATE "Employee" SET "lastActivityAt" = $1 WHERE "userId" IS NOT NULL`,
        new Date(now.getTime() - 3_600_000),
      );
      return plan;
    });

    // Утро дня — снимок для «Сбросить демо» и тихой пересборки.
    await snapshotFromBuild(tables, enumColumns);

    // Сегодняшний день до текущей минуты — ещё в схеме сборки.
    options.onProgress?.(0.97, "Сегодняшний день");
    const progress = await withPrismaClient(client, () =>
      replayToday(todayPlan, emptyProgress(todayPlan.dayKey), demoNow()),
    );

    const meta: DemoWorldMeta = {
      dayKey: dayKeyOf(now),
      builtAt: now.toISOString(),
      clockOffsetMs,
      fingerprint: await migrationsFingerprint(),
      stats: {
        ...generator.stats,
        ...Object.fromEntries(Object.entries(generator.timings).map(([key, value]) => [`мс ${key}`, Math.round(value)])),
      },
      failures: generator.failures,
      durationMs: 0,
    };

    options.onProgress?.(0.99, "Подмена мира");
    await swapBuildIntoLive(tables, enumColumns);
    await applyDemoClockOffset(clockOffsetMs);
    await promoteSnapshot();
    meta.durationMs = realNowMs() - startedAt;
    await writeDemoState("world-meta", meta);
    await writeDemoState("today-plan", todayPlan);
    await writeDemoState("today-progress", progress);
    await writeDemoState("last-rebuild-at", new Date(realNowMs()).toISOString());
    options.onProgress?.(1, "Готово");
    return meta;
  } finally {
    await client.$disconnect().catch(() => undefined);
    await dropBuildSchema();
  }
}

/**
 * Вернуть мир к утреннему снимку и провести сегодняшний день до текущей
 * минуты («Сбросить демо», тихая пересборка). Атомарно, как сборка.
 */
export async function restoreDemoSnapshot(clockOffsetMs = currentWorkdayClockOffset(realNowMs())) {
  await ensureDemoSchemas();
  const result = await withDemoLease(WORLD_LEASE, () => restoreUnderLease(clockOffsetMs));
  if (!result.ran) throw new DemoWorldBusyError();
  return result.value;
}

async function restoreUnderLease(clockOffsetMs: number) {
  const now = new Date(realNowMs() + clockOffsetMs);
  const tables = await orderByForeignKeys(await listDataTables());
  const present = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
    SNAPSHOT_SCHEMA,
  );
  const snapshotTables = new Set(present.map((row) => row.table_name));
  if (!tables.every((table) => snapshotTables.has(table.name))) {
    throw new Error("Снимка демо нет или он от другой схемы базы.");
  }
  const { enums, enumColumns } = await describeEnums(tables);
  const plan = await readDemoState<TodayPlan>("today-plan");

  await prepareBuildSchema(tables, enums, enumColumns);
  const client = createBuildClient();
  try {
    await buildFromSnapshot(tables, enumColumns);
    const progress = plan
      ? await withPrismaClient(client, async () => {
          await prisma.kkmDevice.updateMany({ data: { lastHeartbeatAt: now } });
          return replayToday(plan, emptyProgress(plan.dayKey), now);
        })
      : null;
    await swapBuildIntoLive(tables, enumColumns);
    await applyDemoClockOffset(clockOffsetMs);
    const meta = await readDemoWorldMeta();
    if (meta) await writeDemoState("world-meta", { ...meta, clockOffsetMs });
    if (progress) await writeDemoState("today-progress", progress);
    await writeDemoState("last-rebuild-at", new Date(realNowMs()).toISOString());
    return { advanced: progress?.advanced ?? 0 };
  } finally {
    await client.$disconnect().catch(() => undefined);
    await dropBuildSchema();
  }
}

export async function readDemoWorldMeta() {
  return readDemoState<DemoWorldMeta>("world-meta");
}

/** Снимок годится на сегодня: тот же день и та же схема базы. */
export async function isDemoSnapshotFresh(now = new Date()) {
  const state = await describeDemoWorld(now);
  return state.sameDay && state.sameSchema;
}

/** Что с миром сейчас: есть ли он, сегодняшний ли, та ли схема базы. */
export async function describeDemoWorld(now = new Date()) {
  const meta = await readDemoWorldMeta();
  if (!meta) return { meta: null, sameDay: false, sameSchema: false, lastRebuildAt: null as number | null };
  const lastRebuild = await readDemoState<string>("last-rebuild-at");
  return {
    meta,
    sameDay: meta.dayKey === dayKeyOf(now),
    sameSchema: meta.fingerprint === (await migrationsFingerprint()),
    lastRebuildAt: Date.parse(lastRebuild ?? meta.builtAt) || null,
  };
}

/* ─────────────────────────────────────────────────────── день сегодня */

type TodayProgress = {
  dayKey: string;
  shifts: Record<string, { shiftId: string | null; closed: boolean; skipped?: boolean }>;
  orders: Record<string, { orderId: string | null; done: boolean }>;
  expenses: number[];
  /** Сколько шагов плана проведено последним проходом. */
  advanced?: number;
};

function emptyProgress(dayKey: string): TodayProgress {
  return { dayKey, shifts: {}, orders: {}, expenses: [] };
}

/**
 * Провести план сегодняшнего дня до `now` в живом мире (раз в три минуты):
 * открыть смены, завести заказы, которые уже начались, оплатить те, что
 * закончились, вечером закрыть смену. Посетитель мог закрыть смену сам —
 * тогда план по этой точке стоит (до тихой пересборки).
 */
export async function advanceDemoToday(now: Date) {
  const plan = await readDemoState<TodayPlan>("today-plan");
  if (!plan || plan.dayKey !== dayKeyOf(now)) return { advanced: 0 };
  const stored = await readDemoState<TodayProgress>("today-progress");
  const progress = stored && stored.dayKey === plan.dayKey ? stored : emptyProgress(plan.dayKey);
  const result = await replayToday(plan, progress, now);
  await writeDemoState("today-progress", result);
  return { advanced: result.advanced ?? 0 };
}

/**
 * Ядро прохода дня: план и прогресс приходят снаружи, в состояние ничего не
 * пишется — так тот же проход работает и в живом мире, и в схеме сборки
 * (внутри `withPrismaClient`).
 */
async function replayToday(plan: TodayPlan, progress: TodayProgress, now: Date): Promise<TodayProgress> {
  if (plan.dayKey !== dayKeyOf(now)) return { ...progress, advanced: 0 };

  const generator = new DemoHistoryGenerator({ now, historyDays: 0, futureDays: 0 });
  await generator.loadCatalog();
  const nowAt = now.getTime();
  let advanced = 0;

  for (const shiftPlan of plan.shifts) {
    const state = progress.shifts[shiftPlan.branchId];
    if (!state && shiftPlan.openAt <= nowAt) {
      const open = await prisma.shift.findFirst({ where: { branchId: shiftPlan.branchId, status: "open" }, select: { id: true } });
      if (open) {
        progress.shifts[shiftPlan.branchId] = { shiftId: open.id, closed: false };
      } else {
        const context = await generator.openShiftAt(shiftPlan.branchId, shiftPlan.openAt, shiftPlan.staffIds).catch(() => null);
        progress.shifts[shiftPlan.branchId] = { shiftId: context?.id ?? null, closed: false, skipped: !context };
        advanced += 1;
      }
    }
  }

  const due: Array<{ at: number; kind: "create" | "complete" | "expense"; index: number }> = [];
  plan.orders.forEach((order, index) => {
    const state = progress.orders[order.id];
    if (!state && order.startAt <= nowAt) due.push({ at: order.startAt, kind: "create", index });
    if (order.finishAt <= nowAt && (!state || (!state.done && state.orderId))) due.push({ at: order.finishAt, kind: "complete", index });
  });
  plan.expenses.forEach((expense, index) => {
    if (expense.at <= nowAt && !progress.expenses.includes(index)) due.push({ at: expense.at, kind: "expense", index });
  });
  due.sort((left, right) => left.at - right.at);

  for (const step of due) {
    if (step.kind === "expense") {
      const expense = plan.expenses[step.index];
      progress.expenses.push(step.index);
      const shift = await generator.openShiftContext(expense.branchId);
      if (shift) await generator.addExpenseAt(expense, shift).catch(() => undefined);
      continue;
    }
    const order = plan.orders[step.index];
    const shift = await generator.openShiftContext(order.branchId);
    if (step.kind === "create") {
      if (!shift) {
        progress.orders[order.id] = { orderId: null, done: true };
        continue;
      }
      const created = await generator.createPlannedOrder(order, shift).catch(() => null);
      progress.orders[order.id] = { orderId: created?.orderId ?? null, done: !created };
      advanced += 1;
    } else {
      const state = progress.orders[order.id];
      if (!state?.orderId || state.done) continue;
      state.done = true;
      if (!shift) continue;
      const exists = await prisma.order.findUnique({ where: { id: state.orderId }, select: { status: true } });
      if (!exists || exists.status !== "В работе") continue;
      await generator.completePlannedOrder(order, state.orderId, shift, null).catch(() => undefined);
      advanced += 1;
    }
  }

  for (const shiftPlan of plan.shifts) {
    const state = progress.shifts[shiftPlan.branchId];
    if (state?.shiftId && !state.closed && shiftPlan.closeAt <= nowAt) {
      state.closed = true;
      const shift = await prisma.shift.findUnique({ where: { id: state.shiftId }, select: { status: true } });
      if (shift?.status === "open") {
        await generator.printPendingReceipts(shiftPlan.branchId, shiftPlan.closeAt - 60_000).catch(() => undefined);
        await runAtDemoTime(shiftPlan.closeAt, async () => {
          const { closeShiftForBranch } = await import("@/server/repositories/shift-write-repository");
          await closeShiftForBranch({
            branchId: shiftPlan.branchId,
            shiftId: state.shiftId!,
            actorEmployeeId: demoAdminForBranch(shiftPlan.branchId).id,
          });
        }).catch(() => undefined);
        advanced += 1;
      }
    }
  }

  if (advanced > 0) {
    await runKkmDemoHelper(DEMO_BRANCHES.map((branch) => branch.id)).catch(() => undefined);
    await alignTodayTimestamps();
  }
  return { ...progress, advanced };
}

/** То же выравнивание времени, но только для сегодняшних строк. */
async function alignTodayTimestamps() {
  // В обе стороны: при часах демо-мира метка базы бывает и раньше события
  // (мир «на 14:00», а на машине ночь), не только позже.
  const off = (column: string, event: string, seconds = 600) => `abs(extract(epoch FROM ${column} - ${event})) > ${seconds}`;
  await prisma.$executeRawUnsafe(`UPDATE "Payment" SET "createdAt" = "paidAt" WHERE ${off(`"createdAt"`, `"paidAt"`)}`);
  await prisma.$executeRawUnsafe(`UPDATE "Shift" SET "createdAt" = "openedAt" WHERE ${off(`"createdAt"`, `"openedAt"`)}`);
  await prisma.$executeRawUnsafe(
    `UPDATE "AuditEvent" SET "createdAt" = ("payloadJson"->>'dateTime')::timestamptz WHERE "payloadJson" ? 'dateTime' AND ("payloadJson"->>'dateTime') ~ '^\\d{4}-\\d{2}-\\d{2}T' AND ${off(`"createdAt"`, `("payloadJson"->>'dateTime')::timestamptz`)}`,
  );
  // Чек «передан кассе» — когда принята оплата (как у истории в сборке). Порог
  // час: сдвиг часов демо-мира — часы, а чек «по выбору» посетитель вправе
  // пробить через четверть часа после оплаты — такой не трогаем.
  await prisma.$executeRawUnsafe(
    `UPDATE "KkmOperation" k SET "createdAt" = p.paid FROM (SELECT kp."operationId" AS id, min(pm."paidAt") AS paid FROM "KkmOperationPayment" kp JOIN "Payment" pm ON pm.id = kp."paymentId" GROUP BY kp."operationId") p WHERE p.id = k.id AND ${off(`k."createdAt"`, `p.paid`, 3600)}`,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "KkmOperationEvent" ev SET "createdAt" = k."createdAt" FROM "KkmOperation" k WHERE k.id = ev."operationId" AND ev."eventType" = 'created' AND ${off(`ev."createdAt"`, `k."createdAt"`, 3600)}`,
  );
}
