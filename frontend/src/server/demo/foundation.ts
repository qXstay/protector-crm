import { createHash, randomBytes, randomInt } from "node:crypto";

import argon2 from "argon2";
import type { Prisma, PrismaClient } from "@prisma/client";

import { ensureServiceCatalogFoundation, recoverServiceCatalogFromSeed } from "@/server/repositories/service-catalog-repository";
import { defaultPayrollFormulaSettings, toStoredPayrollFormulaSettingsJson } from "@/features/payroll/payroll-formula-settings";

/** Та же строка, что у `/api/settings/payroll-formula` (одна на систему). */
const DEMO_PAYROLL_FORMULA_SETTINGS_ID = "payroll-formula-default";

/**
 * Коды федеральных операторов для телефонов мастеров — те же, что у клиентов
 * демо-мира (`generator.ts`), без привязки к одному региону.
 */
const EMPLOYEE_PHONE_OPERATORS = ["900", "901", "903", "905", "906", "909", "915", "916", "925", "926", "929", "950", "951", "960", "961", "965", "977", "985", "999"];

/**
 * Основа демо-данных: точки, роли и права, сотрудники со входом, счета,
 * настройки записи и хранения, демо-касса. Та же структура, что у
 * `prisma/seed.mjs`, но с командой витрины: у каждой роли — свой вход.
 *
 * PIN демо-сотрудников — из `SHOWCASE_DEMO_PIN` (или PIN владельца из
 * `AUTH_BOOTSTRAP_OWNER_PIN`); если не задан ни один, PIN случайный и
 * обычный вход по номеру просто не пройдёт — кнопки «Войти как …» работают
 * без него.
 */

export type DemoBranch = {
  id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  /** Поток заказов относительно средней точки. */
  traffic: number;
  shelves: number;
  cells: number;
  storagePrefix: string;
};

export const DEMO_BRANCHES: DemoBranch[] = [
  {
    id: "branch-lesnaya-1",
    code: "lesnaya-1",
    name: "Лесная 1",
    address: "ул. Лесная, 1",
    phone: "+7 900 000-00-11",
    traffic: 1.2,
    shelves: 6,
    cells: 12,
    storagePrefix: "Л",
  },
  {
    id: "branch-sadovaya-2",
    code: "sadovaya-2",
    name: "Садовая 2",
    address: "ул. Садовая, 2",
    phone: "+7 900 000-00-12",
    traffic: 1,
    shelves: 5,
    cells: 10,
    storagePrefix: "С",
  },
  {
    id: "branch-zavodskaya-3",
    code: "zavodskaya-3",
    name: "Заводская 3",
    address: "ул. Заводская, 3",
    phone: "+7 900 000-00-13",
    traffic: 0.85,
    shelves: 8,
    cells: 12,
    storagePrefix: "З",
  },
];

const PERMISSION_GROUPS: Array<{ id: string; permissions: Array<{ id: string; label: string }> }> = [
  { id: "analytics", permissions: [{ id: "analytics.view", label: "Просмотр аналитики" }] },
  {
    id: "booking",
    permissions: [
      { id: "booking.view", label: "Просмотр записей" },
      { id: "booking.create", label: "Создание записей" },
      { id: "booking.edit_own", label: "Редактирование своих записей" },
      { id: "booking.edit_all", label: "Редактирование всех записей" },
      { id: "booking.delete_own", label: "Удаление своих записей" },
      { id: "booking.delete_all", label: "Удаление всех записей" },
    ],
  },
  {
    id: "shift",
    permissions: [
      { id: "shift.view", label: "Просмотр смен" },
      { id: "shift.open", label: "Открытие смены" },
      { id: "shift.close", label: "Закрытие смены" },
    ],
  },
  {
    id: "order",
    permissions: [
      { id: "order.view", label: "Просмотр заказов" },
      { id: "order.create", label: "Создание заказов" },
      { id: "order.edit_own", label: "Редактирование своих заказов" },
      { id: "order.edit_all", label: "Редактирование всех заказов" },
      { id: "order.delete_own", label: "Удаление своих заказов" },
      { id: "order.delete_all", label: "Удаление всех заказов" },
    ],
  },
  {
    id: "storage",
    permissions: [
      { id: "storage.view", label: "Просмотр склада" },
      { id: "storage.create", label: "Создание записей" },
      { id: "storage.edit_own", label: "Редактирование своих записей" },
      { id: "storage.edit_all", label: "Редактирование всех записей" },
    ],
  },
  {
    id: "client",
    permissions: [
      { id: "client.view", label: "Просмотр клиентов" },
      { id: "client.create", label: "Создание клиентов" },
      { id: "client.edit", label: "Редактирование клиентов" },
      { id: "client.delete", label: "Удаление клиентов" },
    ],
  },
  {
    id: "finance",
    permissions: [
      { id: "finance.view", label: "Просмотр финансов" },
      { id: "finance.create", label: "Создание финансов" },
      { id: "finance.delete", label: "Удаление финансов" },
    ],
  },
  { id: "report", permissions: [{ id: "report.view", label: "Просмотр отчетов" }] },
  { id: "kkm", permissions: [{ id: "kkm.manage", label: "Кассы: настройка, проверка и возврат" }] },
  {
    id: "settings",
    permissions: [
      { id: "settings.main", label: "Общие настройки" },
      { id: "settings.booking", label: "Настройки бронирования" },
      { id: "settings.employees", label: "Настройки сотрудников" },
      { id: "settings.roles", label: "Настройки ролей" },
      { id: "settings.services", label: "Настройки услуг" },
      { id: "settings.clients", label: "Настройки клиентов" },
      { id: "settings.storage", label: "Настройки склада" },
      { id: "settings.accounts", label: "Настройки счетов" },
      { id: "settings.branch", label: "Настройки филиалов" },
    ],
  },
];

const ALL_PERMISSION_IDS = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((permission) => permission.id));

/** Системная роль «Сотрудник» — те же права, что в `seed.mjs`. */
const EMPLOYEE_PERMISSION_IDS = [
  "booking.view",
  "booking.create",
  "shift.view",
  "shift.open",
  "shift.close",
  "order.view",
  "order.create",
  "storage.view",
  "storage.edit_own",
  "client.view",
  "client.create",
  "client.edit",
];

/**
 * «Управляющий» — роль, заведённая штатным экраном «Права доступа»: всё, что
 * нужно для работы сети и отчётов, но без сотрудников, ролей, счетов и касс.
 */
const MANAGER_PERMISSION_IDS = [
  "analytics.view",
  "booking.view",
  "booking.create",
  "booking.edit_all",
  "booking.delete_all",
  "shift.view",
  "shift.open",
  "shift.close",
  "order.view",
  "order.create",
  "order.edit_all",
  "storage.view",
  "storage.create",
  "storage.edit_all",
  "client.view",
  "client.create",
  "client.edit",
  "finance.view",
  "report.view",
  "settings.booking",
  "settings.storage",
  "settings.clients",
];

export const DEMO_ROLE_IDS = {
  owner: "owner",
  manager: "demo-manager",
  employee: "developer",
} as const;

export type DemoLoginRole = keyof typeof DEMO_ROLE_IDS;

type DemoEmployeeDefinition = {
  id: string;
  firstName: string;
  lastName: string;
  middleName: string;
  roleId: string;
  phone: string;
  login?: { userId: string; login: string; role: DemoLoginRole };
  skillLevel: string | null;
  workPercent: string;
  shiftMinimum: string;
  addMinimumToWorkPercent?: boolean;
  canBeAssignedExecutor: boolean;
  branches: string[];
  defaultBranchId: string;
  hiredDaysAgo: number;
};

const LESNAYA = "branch-lesnaya-1";
const SADOVAYA = "branch-sadovaya-2";
const ZAVODSKAYA = "branch-zavodskaya-3";
const ALL_BRANCHES = [LESNAYA, SADOVAYA, ZAVODSKAYA];

export const DEMO_EMPLOYEES: DemoEmployeeDefinition[] = [
  {
    id: "employee-demo-owner",
    firstName: "Андрей",
    lastName: "Соколов",
    middleName: "Викторович",
    roleId: DEMO_ROLE_IDS.owner,
    phone: "+7 900 000-05-01",
    login: { userId: "user-demo-owner", login: "9000000501", role: "owner" },
    skillLevel: null,
    workPercent: "0",
    shiftMinimum: "0",
    canBeAssignedExecutor: false,
    branches: ALL_BRANCHES,
    defaultBranchId: LESNAYA,
    hiredDaysAgo: 1460,
  },
  {
    id: "employee-demo-manager",
    firstName: "Марина",
    lastName: "Лебедева",
    middleName: "Сергеевна",
    roleId: DEMO_ROLE_IDS.manager,
    phone: "+7 900 000-05-02",
    login: { userId: "user-demo-manager", login: "9000000502", role: "manager" },
    skillLevel: null,
    workPercent: "0",
    shiftMinimum: "0",
    canBeAssignedExecutor: false,
    branches: ALL_BRANCHES,
    defaultBranchId: LESNAYA,
    hiredDaysAgo: 900,
  },
  {
    id: "employee-demo-admin",
    firstName: "Павел",
    lastName: "Гусев",
    middleName: "Андреевич",
    roleId: DEMO_ROLE_IDS.employee,
    phone: "+7 900 000-05-03",
    login: { userId: "user-demo-admin", login: "9000000503", role: "employee" },
    skillLevel: null,
    workPercent: "0",
    shiftMinimum: "1500",
    canBeAssignedExecutor: false,
    branches: [LESNAYA],
    defaultBranchId: LESNAYA,
    hiredDaysAgo: 410,
  },
  // Администраторы двух других точек — без входа в витрине.
  master("employee-demo-admin-sad", "Ольга", "Корнилова", "Игоревна", null, "0", "1500", [SADOVAYA], 380, false),
  master("employee-demo-admin-zav", "Елена", "Шубина", "Павловна", null, "0", "1500", [ZAVODSKAYA], 260, false),
  // Мастера. Уровень 1 — старший мастер, 3 — стажёр.
  master("employee-demo-m1", "Дмитрий", "Волков", "Сергеевич", "level_1", "35", "2000", [LESNAYA, SADOVAYA], 1200),
  master("employee-demo-m2", "Артём", "Зуев", "Игоревич", "level_2", "30", "1500", [LESNAYA], 640),
  master("employee-demo-m3", "Никита", "Ершов", "Олегович", "level_3", "30", "1000", [LESNAYA], 95),
  master("employee-demo-m4", "Руслан", "Галиев", "Маратович", "level_1", "35", "2000", [SADOVAYA], 980),
  master("employee-demo-m5", "Кирилл", "Щукин", "Андреевич", "level_2", "30", "1500", [SADOVAYA, ZAVODSKAYA], 520),
  master("employee-demo-m6", "Сергей", "Панов", "Владимирович", "level_3", "30", "1000", [SADOVAYA], 70),
  master("employee-demo-m7", "Виктор", "Лаптев", "Николаевич", "level_1", "35", "2000", [ZAVODSKAYA], 1500),
  master("employee-demo-m8", "Игорь", "Мухин", "Петрович", "level_2", "30", "1500", [ZAVODSKAYA], 450),
  master("employee-demo-m9", "Тимур", "Ахметов", "Ринатович", "level_3", "30", "1000", [ZAVODSKAYA, LESNAYA], 120),
];

function master(
  id: string,
  firstName: string,
  lastName: string,
  middleName: string,
  skillLevel: string | null,
  workPercent: string,
  shiftMinimum: string,
  branches: string[],
  hiredDaysAgo: number,
  canBeAssignedExecutor = true,
): DemoEmployeeDefinition {
  return {
    id,
    firstName,
    lastName,
    middleName,
    roleId: DEMO_ROLE_IDS.employee,
    phone: `+7 ${EMPLOYEE_PHONE_OPERATORS[hashCode(id) % EMPLOYEE_PHONE_OPERATORS.length]} ${String(100 + (hashCode(id) % 900)).padStart(3, "0")}-${String(10 + (hashCode(id + "a") % 90))}-${String(10 + (hashCode(id + "b") % 90))}`,
    skillLevel,
    workPercent,
    shiftMinimum,
    canBeAssignedExecutor,
    branches,
    defaultBranchId: branches[0],
    hiredDaysAgo,
  };
}

function hashCode(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash;
}

export function demoMastersForBranch(branchId: string) {
  return DEMO_EMPLOYEES.filter(
    (employee) => employee.canBeAssignedExecutor && employee.branches.includes(branchId),
  );
}

export function demoAdminForBranch(branchId: string) {
  return (
    DEMO_EMPLOYEES.find(
      (employee) =>
        !employee.canBeAssignedExecutor &&
        employee.roleId === DEMO_ROLE_IDS.employee &&
        employee.defaultBranchId === branchId,
    ) ?? DEMO_EMPLOYEES[0]
  );
}

export function demoEmployeeShortName(employeeId: string) {
  const employee = DEMO_EMPLOYEES.find((item) => item.id === employeeId);
  return employee ? `${employee.lastName} ${employee.firstName.slice(0, 1)}.` : "Сотрудник";
}

export function demoLoginEmployee(role: DemoLoginRole) {
  return DEMO_EMPLOYEES.find((employee) => employee.login?.role === role)!;
}

function resolveDemoPin() {
  const candidates = [process.env.SHOWCASE_DEMO_PIN, process.env.AUTH_BOOTSTRAP_OWNER_PIN];
  const pin = candidates.map((value) => value?.trim() ?? "").find((value) => /^\d{4,6}$/.test(value));
  return pin ?? String(randomInt(100000, 999999));
}

const CLIENT_SOURCES = ["интернет", "Яндекс Карты", "2ГИС", "по рекомендации", "проезжали мимо", "постоянный клиент"];

/**
 * Записать основу. База уже очищена (`wipeDemoTables`). `now` — момент сборки
 * (настоящее время), от него считаются даты приёма сотрудников.
 */
export async function writeDemoFoundation(prisma: PrismaClient, now: Date) {
  const pinHash = await argon2.hash(resolveDemoPin());
  const days = (count: number) => new Date(now.getTime() - count * 86_400_000);
  const stamp = days(400);

  await prisma.branch.createMany({
    data: DEMO_BRANCHES.map((branch) => ({
      id: branch.id,
      code: branch.code,
      name: branch.name,
      displayName: branch.name,
      address: branch.address,
      phone: branch.phone,
      createdAt: stamp,
    })),
  });

  await prisma.permission.createMany({
    data: PERMISSION_GROUPS.flatMap((group) =>
      group.permissions.map((permission) => ({
        id: permission.id,
        groupKey: group.id,
        actionKey: permission.id.split(".")[1] ?? permission.id,
        label: permission.label,
        createdAt: stamp,
      })),
    ),
  });

  await prisma.role.createMany({
    data: [
      { id: DEMO_ROLE_IDS.employee, name: "Сотрудник", systemKey: "developer", isSystem: true, createdAt: stamp },
      { id: DEMO_ROLE_IDS.owner, name: "Владелец", systemKey: "owner", isSystem: true, createdAt: stamp },
      { id: DEMO_ROLE_IDS.manager, name: "Управляющий", systemKey: null, isSystem: false, createdAt: days(300) },
    ],
  });

  await prisma.rolePermission.createMany({
    data: [
      ...EMPLOYEE_PERMISSION_IDS.map((permissionId) => ({ roleId: DEMO_ROLE_IDS.employee, permissionId })),
      ...ALL_PERMISSION_IDS.map((permissionId) => ({ roleId: DEMO_ROLE_IDS.owner, permissionId })),
      ...MANAGER_PERMISSION_IDS.map((permissionId) => ({ roleId: DEMO_ROLE_IDS.manager, permissionId })),
    ],
  });

  for (const employee of DEMO_EMPLOYEES) {
    if (employee.login) {
      await prisma.user.create({
        data: {
          id: employee.login.userId,
          login: employee.login.login,
          phone: employee.phone,
          pinHash,
          isActive: true,
          createdAt: days(employee.hiredDaysAgo),
        },
      });
    }

    await prisma.employee.create({
      data: {
        id: employee.id,
        userId: employee.login?.userId ?? null,
        phone: employee.phone,
        firstName: employee.firstName,
        lastName: employee.lastName,
        middleName: employee.middleName,
        roleId: employee.roleId,
        hiredAt: days(employee.hiredDaysAgo),
        lastActivityAt: employee.login ? days(0) : null,
        skillLevel: employee.skillLevel,
        workPercent: employee.workPercent,
        shiftMinimum: employee.shiftMinimum,
        addMinimumToWorkPercent: employee.addMinimumToWorkPercent ?? false,
        canBeAssignedExecutor: employee.canBeAssignedExecutor,
        createdAt: days(employee.hiredDaysAgo),
        branchAccesses: {
          create: employee.branches.map((branchId) => ({
            branchId,
            isDefault: branchId === employee.defaultBranchId,
            canOperate: true,
            canSwitchInto: true,
          })),
        },
      },
    });
  }

  for (const branch of DEMO_BRANCHES) {
    await prisma.branchProfile.create({
      data: {
        branchId: branch.id,
        legalName: "ООО «Протектор»",
        displayName: branch.name,
        address: branch.address,
        phone: branch.phone,
        timezoneLabel: "UTC+5",
        workStart: "09:00",
        workEnd: "21:00",
      },
    });

    await prisma.branchPrintSettings.create({
      data: {
        branchId: branch.id,
        receiptTitle: "Шиномонтаж «Протектор»",
        footerNote: "Спасибо! Проверьте давление через 50 км",
        showPhone: true,
        showAddress: true,
      },
    });

    await prisma.paymentAccount.createMany({
      data: [
        { id: `${branch.id}-account-automation-service`, branchId: branch.id, name: "ООО «Протектор»", isProtected: true, createdAt: stamp },
        { id: `${branch.id}-account-ip`, branchId: branch.id, name: "ИП Соколов А. В.", isProtected: true, createdAt: stamp },
        { id: `${branch.id}-account-cash`, branchId: branch.id, name: "Наличные в кассе", isProtected: true, createdAt: stamp },
      ],
    });

    await prisma.bookingSettings.create({
      data: {
        branchId: branch.id,
        publicSlug: branch.code,
        onlineEnabled: true,
        slotWindowMinutes: 15,
        allowPostChoice: true,
        allowMultipleWindows: false,
        metricsId: "0",
        telegramChatId: "0",
        postsJson: [
          { id: "post-1", name: "Пост 1" },
          { id: "post-2", name: "Пост 2" },
          { id: "post-3", name: "Пост 3" },
        ] as Prisma.InputJsonValue,
      },
    });

    await prisma.storageSettings.create({
      data: {
        branchId: branch.id,
        warehousesJson: [
          {
            id: `warehouse-${branch.code}`,
            name: `Склад «${branch.name}»`,
            shelvesCount: branch.shelves,
            cellsCount: branch.cells,
            protected: true,
            createdAt: stamp.toISOString(),
            updatedAt: stamp.toISOString(),
          },
        ] as Prisma.InputJsonValue,
      },
    });

    await prisma.clientSourceSettings.create({
      data: {
        branchId: branch.id,
        sourcesJson: CLIENT_SOURCES.map((name, index) => ({
          id: index === 0 ? "source-internet" : `source-demo-${index}`,
          name,
          protected: index === 0,
          createdAt: stamp.toISOString(),
          updatedAt: stamp.toISOString(),
        })) as Prisma.InputJsonValue,
      },
    });
  }

  // Настройки формулы зарплаты сохранены, как у настроенной
  // установки (та же строка, что пишет «Сохранить» в настройках зарплаты,
  // значения по умолчанию системы). Без них система не кладёт в снимок
  // заказа правила деления фонда, и заказ посетителя с несколькими
  // мастерами («процент от прибыли», «фикс», 4+ исполнителей) оставался
  // «расчёт требует проверки».
  await prisma.payrollFormulaSettings.create({
    data: {
      id: DEMO_PAYROLL_FORMULA_SETTINGS_ID,
      fourPlusLevelWeightsJson: toStoredPayrollFormulaSettingsJson(defaultPayrollFormulaSettings()) as Prisma.InputJsonValue,
      createdAt: stamp,
    },
  });

  await ensureServiceCatalogFoundation(prisma);
  // Демо-мир всегда начинается со встроенного каталога и его демо-цен: цены
  // из прошлых сборок (или правки посетителей) перезаписываются.
  await recoverServiceCatalogFromSeed();
}

/** Демо-касса в каждой точке (`SHOWCASE_KKM_DEMO=1`). Подключена с начала истории. */
export async function writeDemoKkmDevices(prisma: PrismaClient, connectedAt: Date) {
  for (const [index, branch] of DEMO_BRANCHES.entries()) {
    await prisma.kkmDevice.create({
      data: {
        id: `kkm-device-demo-${branch.code}`,
        branchId: branch.id,
        label: `Касса «${branch.name}»`,
        // Заводской номер и РНМ заведомо вымышленные — нули и номер точки (так
        // и пример РНМ в схеме системы: 0000000000000001), чтобы на экране
        // «Кассы» они не выглядели номерами настоящих касс.
        fiscalSerial: `0000000000000${index + 1}`,
        registrationNumber: `000000000000000${index + 1}`,
        isActive: true,
        helperTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        helperVersion: "1.0",
        createdAt: connectedAt,
      },
    });
  }
}
