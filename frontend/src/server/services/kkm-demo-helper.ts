import { createHash, randomBytes } from "node:crypto";

import {
  isKkmFiscalReceiptKind,
  kkmFnDocumentTypeForKind,
  readKkmReceiptTotalCents,
  type KkmHeartbeat,
  type KkmKktShift,
} from "@/features/kkm/helper-protocol";
import { prisma } from "@/server/db/prisma";
import { realNowMs } from "@/server/demo/clock";
import {
  leaseKkmOperationForDevice,
  recordKkmCheckAnswer,
  recordKkmHeartbeat,
  recordKkmHelperEvent,
  recordKkmHelperResult,
  type KkmHelperDevice,
  type KkmHelperOperationView,
} from "@/server/repositories/kkm-helper-repository";
import { isWorldSwapInProgress } from "@/server/demo/swap-state";

/**
 * Демо-касса витрины (`SHOWCASE_KKM_DEMO=1`).
 *
 * Настоящий помощник кассы стоит на компьютере точки и сам забирает операции
 * из облака. В витрине его нет, поэтому тот же круг — аренда, `started`, итог
 * с документом ФН, ответ на «Проверить кассу», сигнал жизни — проходит здесь,
 * на сервере, когда экран спрашивает о кассе. Запись идёт теми же функциями и
 * проверками, что у настоящего помощника, поэтому на экране обычное «Чек
 * пробит» с номером документа, а очередь и журнал операций настоящие.
 *
 * У филиала без кассы демо-касса заводится при первом обращении, так что чек
 * пробивается из любой точки. Выключенную владельцем кассу модуль не трогает.
 * Без флага модуль ничего не делает: тесты и стенд работают «без кассы».
 */

// Версия помощника, как её показывает настоящий помощник на компьютере точки:
// на экране «Кассы» — «помощник 1.0», без слова «демо».
const DEMO_HELPER_VERSION = "1.0";
const DEMO_KKT_SHIFT: KkmKktShift = { state: "open", number: 1 };
const HEARTBEAT_EVERY_MS = 15_000;
const MAX_OFFERS_PER_TICK = 10;

const lastHeartbeatAtByDevice = new Map<string, number>();
const tickByBranch = new Map<string, Promise<void>>();

export function isKkmDemoEnabled(env: Record<string, string | undefined> = process.env) {
  return env.SHOWCASE_KKM_DEMO === "1";
}

/**
 * Один круг демо-кассы по каждому филиалу. Круги одного филиала идут друг за
 * другом, чтобы два опроса экрана не взяли один номер документа ФН.
 */
export async function runKkmDemoHelper(branchIds: readonly string[]) {
  // Пока мир подменяется, строка кассы занята транзакцией подмены: запись
  // сигнала ждала бы её конца, а с ней и ответ экрану. Круг сделает следующий опрос.
  if (!isKkmDemoEnabled() || isWorldSwapInProgress()) {
    return;
  }

  for (const branchId of new Set(branchIds)) {
    const previous = tickByBranch.get(branchId) ?? Promise.resolve();
    const next = previous
      .then(() => tickBranch(branchId))
      .catch((error: unknown) => {
        console.error("[kkm-demo] круг демо-кассы не прошёл", error);
      });

    tickByBranch.set(branchId, next);
    await next;
  }
}

async function tickBranch(branchId: string) {
  const device = await ensureDemoDevice(branchId);

  if (!device) {
    return;
  }

  const helper: KkmHelperDevice = { id: device.id, branchId: device.branchId };
  // Частота сигнала — по настоящему времени: «сейчас» сервера витрины сдвигают
  // часы мира, и после пересборки сдвиг меняется — по сдвинутым часам сигнал
  // замолкал на часы, и касса выглядела «не на связи».
  const now = realNowMs();

  if (now - (lastHeartbeatAtByDevice.get(device.id) ?? 0) >= HEARTBEAT_EVERY_MS) {
    await recordKkmHeartbeat(helper, demoHeartbeat(device.fiscalSerial));
    lastHeartbeatAtByDevice.set(device.id, now);
  }

  for (let offerIndex = 0; offerIndex < MAX_OFFERS_PER_TICK; offerIndex += 1) {
    const offer = await leaseKkmOperationForDevice(helper, { waitMs: 0, pollMs: 0 });

    if (!offer) {
      return;
    }

    if (offer.action === "check") {
      await recordKkmCheckAnswer(helper, {
        requestedAt: offer.check.requestedAt,
        state: demoHeartbeat(device.fiscalSerial),
      });
      continue;
    }

    // `unknown` у демо-кассы не возникает: исход она знает сразу. Сверку
    // чужой операции оставляем экрану владельца.
    if (offer.action === "reconcile") {
      return;
    }

    await printDemoReceipt(helper, offer.operation);
  }
}

async function ensureDemoDevice(branchId: string) {
  const select = { id: true, branchId: true, fiscalSerial: true, isActive: true } as const;
  const existing = await prisma.kkmDevice.findUnique({ where: { branchId }, select });

  if (existing) {
    return existing.isActive ? existing : null;
  }

  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { code: true } });

  if (!branch) {
    return null;
  }

  return prisma.kkmDevice.create({
    data: {
      id: `kkm-device-demo-${branch.code}`,
      branchId,
      label: "Касса",
      // Заводской номер заведомо вымышленный (одни нули и короткий хвост от кода
      // точки) — на экране «Кассы» он не похож на номер настоящей ККТ.
      fiscalSerial: `00000000${String([...branch.code].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1_000_000, 7)).padStart(6, "0")}`,
      isActive: true,
      // Помощник к демо-кассе не подключается: токен никому не выдаётся.
      helperTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
    },
    select,
  });
}

async function printDemoReceipt(device: KkmHelperDevice, operation: KkmHelperOperationView) {
  const {
    _max: { fiscalDocumentNumber: lastDocumentNumber },
  } = await prisma.kkmOperation.aggregate({
    where: { branchId: device.branchId },
    _max: { fiscalDocumentNumber: true },
  });
  const before = lastDocumentNumber ?? 0;

  const started = await recordKkmHelperEvent(
    device,
    operation.id,
    { type: "started", attempt: operation.attempt, fnDocumentNumber: before, kktShift: DEMO_KKT_SHIFT },
    DEMO_HELPER_VERSION,
  );

  if (started.status !== 200) {
    return;
  }

  const documentType = kkmFnDocumentTypeForKind(operation.kind);
  const number = before + 1;

  await recordKkmHelperResult(
    device,
    operation.id,
    {
      outcome: "done",
      attempt: operation.attempt,
      document:
        isKkmFiscalReceiptKind(operation.kind) && documentType
          ? {
              number,
              type: documentType,
              amountCents: readKkmReceiptTotalCents(operation.request, operation.kind) ?? 0,
              fiscalSign: String(1_000_000_000 + number),
              kktShiftNumber: DEMO_KKT_SHIFT.number,
              dateTime: new Date().toISOString(),
              receiptNumber: number,
            }
          : null,
    },
    DEMO_HELPER_VERSION,
  );
}

function demoHeartbeat(serial: string): KkmHeartbeat {
  return {
    helperVersion: DEMO_HELPER_VERSION,
    windowsTime: new Date().toISOString(),
    device: "present",
    serial,
    kktShift: DEMO_KKT_SHIFT,
    paper: "present",
    driverVersion: DEMO_HELPER_VERSION,
    kktClockDeltaSeconds: 0,
    journalOperations: 0,
  };
}
