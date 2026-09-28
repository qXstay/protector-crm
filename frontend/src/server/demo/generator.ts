import type { DemoOrder, DemoOrderClientSnapshot, DemoOrderPaymentMethod } from "@/features/orders/types";
import type { PricingContext, Radius } from "@/features/pricing/types";
import { getOperationalDayRange, SHOWCASE_OPERATIONAL_TIME_ZONE } from "@/shared/operational-time";
import { prisma } from "@/server/db/prisma";
import { createBookingGroupForBranch } from "@/server/repositories/booking-write-repository";
import { createCashCollectionForBranch, getBranchCashCollectionState } from "@/server/repositories/cash-collection-repository";
import { createClient } from "@/server/repositories/client-repository";
import { createKkmOperationByChoiceForBranch } from "@/server/repositories/kkm-operation-repository";
import { formatShiftLabel } from "@/server/repositories/operational-utils";
import { markOrderForDeletion } from "@/server/repositories/order-deletion-repository";
import {
  appendPaymentForOrderBranch,
  createOrderForBranch,
  updateOrderForBranch,
} from "@/server/repositories/order-write-repository";
import { listServiceCatalog } from "@/server/repositories/service-catalog-repository";
import {
  addShiftExpenseForBranch,
  closeShiftForBranch,
  openShiftForBranch,
} from "@/server/repositories/shift-write-repository";
import {
  createStorageRecordForBranch,
  updateStorageRecordForBranch,
} from "@/server/repositories/storage-write-repository";
import { runKkmDemoHelper } from "@/server/services/kkm-demo-helper";

import { runAtDemoTime } from "./clock";
import {
  BOOKING_COMMENTS,
  CAR_MODELS,
  FEMALE_FIRST_NAMES,
  FEMALE_PATRONYMICS,
  LAST_NAMES,
  LEGAL_CLIENTS,
  MALE_FIRST_NAMES,
  MALE_PATRONYMICS,
  PLATE_LETTERS,
  PLATE_REGIONS,
  SHIFT_EXPENSES,
  TIRE_BRANDS_SUMMER,
  TIRE_BRANDS_WINTER,
  TIRE_SIZE_BY_RADIUS,
  type DemoCarModel,
} from "./dictionaries";
import {
  DEMO_BRANCHES,
  DEMO_EMPLOYEES,
  demoAdminForBranch,
  demoMastersForBranch,
  type DemoBranch,
} from "./foundation";
import {
  buildConductedOrderSnapshot,
  buildDemoCartItem,
  buildWorkingOrderSnapshot,
  indexCatalog,
  PAYMENT_LABELS,
  type DemoCatalog,
  type DemoLineRequest,
} from "./orders";
import { DemoRandom } from "./random";

/* ─────────────────────────────────────────────────────────────── время */

const MINUTE = 60_000;
/** Сколько дней истории получают записи (заказы и смены — за всю историю). */
const BOOKING_HISTORY_DAYS = 28;
const DAY = 86_400_000;

export function dayKeyOf(date: Date) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: SHOWCASE_OPERATIONAL_TIME_ZONE }).format(date);
}

export function addDays(dayKey: string, amount: number) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

/** Момент «ЧЧ:ММ по времени точки» в операционный день. */
export function localMoment(dayKey: string, minutesOfDay: number) {
  return new Date(getOperationalDayRange(dayKey).start.getTime() + minutesOfDay * MINUTE);
}

function weekday(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function hhmm(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Недельный ритм сети: история ровная, без «сезона» и роста к
 * сегодняшнему дню — настоящая сеть так не работает. Будни ровные, к пятнице
 * оживлённее, суббота — самый загруженный день, воскресенье спокойнее
 * субботы. Ритм задаёт второй пост (часы пик), первый работает весь день;
 * у каждого дня свой небольшой разброс, поэтому неделя к неделе отличается
 * на несколько процентов в обе стороны. Вс = 0.
 */
const WEEKDAY_INTENSITY = [0.97, 0.9, 0.9, 0.92, 0.95, 1.05, 1.2];

/**
 * Набор работ сети — один на всю историю: переобувка и хранение, ремонт,
 * балансировка, диски, датчики, шипы (раньше в последние дни мир
 * переключался на «сезонный» набор, и чек рос вместе с потоком).
 */
const ORDER_KIND_WEIGHTS = { season: 46, repair: 24, balance: 14, disk: 6, sensor: 5, studs: 5 } as const;

const MATRIX_SERVICES = new Set(["main-package", "installation", "demount", "mount", "balancing", "washing"]);

/** Записей на будущие дни по дню недели (вс = 0): клиенты записываются вперёд. */
const FUTURE_BOOKINGS_BASE = [7, 5.5, 5.5, 6, 6.5, 8, 10.5];

/* ───────────────────────────────────────────────────────────── клиенты */

type PoolClient = {
  id: string;
  vehicleId: string | null;
  fullName: string;
  phone: string;
  kind: "individual" | "legal";
  inn: string | null;
  car: DemoCarModel;
  radius: Radius;
  plateNumber: string;
  lowProfile: boolean;
  runflat: boolean;
  homeBranchId: string;
  lastVisit: number;
  storage: { recordId: string; branchId: string; season: "winter" | "summer" } | null;
};

type Person = {
  firstName: string;
  lastName: string;
  middleName: string;
  phone: string;
};

export type NewClientSpec = {
  person: Person;
  brand: string;
  model: string;
  radius: Radius;
  lowProfile: boolean;
  runflat: boolean;
  plateNumber: string;
};

/* ─────────────────────────────────────────────────────────────── план */

export type PlannedPayment = {
  method: DemoOrderPaymentMethod;
  note: string;
  /** Чек за наличные/перевод: `with_qr` — фискальный, `without_qr` — нефискальная печать. */
  receipt: "with_qr" | "without_qr" | "auto" | "none";
};

export type PlannedOrder = {
  id: string;
  branchId: string;
  startAt: number;
  finishAt: number;
  clientId: string | null;
  newClient: NewClientSpec | null;
  anonymousCar: { brand: string; model: string } | null;
  context: PricingContext;
  lines: DemoLineRequest[];
  discountPercent: number;
  executorIds: string[];
  payment: PlannedPayment | null;
  /** Долг: заказ «Выполнен», оплата позже. */
  payLaterAt: number | null;
  storageRelease: string | null;
  storageAccept: { season: "winter" | "summer"; label: string } | null;
  markForDeletion: boolean;
  internalComment?: string;
};

export type TodayPlan = {
  dayKey: string;
  shifts: Array<{ branchId: string; openAt: number; closeAt: number; staffIds: string[] }>;
  orders: PlannedOrder[];
  expenses: Array<{ branchId: string; at: number; amount: number; description: string }>;
};

export type GenerationProgress = (fraction: number, label: string) => void;

type GeneratorOptions = {
  now: Date;
  historyDays: number;
  futureDays: number;
  seed?: string;
  onProgress?: GenerationProgress;
  onBooking?: (groupId: string, createdAt: number) => void;
  kkmReceipts?: boolean;
};

type ShiftContext = {
  id: string;
  number: number;
  openedAt: string;
  staffIds: string[];
  labels: Map<string, string>;
};

/* ─────────────────────────────────────────────────────────── генератор */

export class DemoHistoryGenerator {
  private readonly rng: DemoRandom;
  private catalog!: DemoCatalog;
  private readonly clients: PoolClient[] = [];
  private readonly usedPlates = new Set<string>();
  private readonly usedPhones = new Set<string>();
  private readonly storageCounters = new Map<string, number>();
  private readonly occupiedCells = new Map<string, Set<string>>();
  private readonly kkmReceipts: boolean;
  private readonly todayKey: string;
  private orderSequence = 0;
  readonly stats = { orders: 0, payments: 0, clients: 0, bookings: 0, storage: 0, shifts: 0, failures: 0 };
  readonly failures: string[] = [];
  readonly timings: Record<string, number> = {};

  async timed<T>(label: string, task: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await task();
    } finally {
      this.timings[label] = (this.timings[label] ?? 0) + (performance.now() - started);
    }
  }

  constructor(private readonly options: GeneratorOptions) {
    this.todayKey = dayKeyOf(options.now);
    this.rng = new DemoRandom(options.seed ?? `protektor-${this.todayKey}`);
    this.kkmReceipts = options.kkmReceipts ?? true;
  }

  private progress(fraction: number, label: string) {
    this.options.onProgress?.(Math.min(1, Math.max(0, fraction)), label);
  }

  private fail(where: string, error: unknown) {
    this.stats.failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    if (this.failures.length < 50) this.failures.push(`${where}: ${message}`);
  }

  async loadCatalog() {
    this.catalog = indexCatalog(await listServiceCatalog());
  }

  /* ------------------------------------------------------------ люди */

  private person(sex: "m" | "f" = this.rng.chance(0.78) ? "m" : "f"): Person {
    const [maleLast, femaleLast] = this.rng.pick(LAST_NAMES);
    const firstName = sex === "m" ? this.rng.pick(MALE_FIRST_NAMES) : this.rng.pick(FEMALE_FIRST_NAMES);
    const middleName = sex === "m" ? this.rng.pick(MALE_PATRONYMICS) : this.rng.pick(FEMALE_PATRONYMICS);
    return { firstName, lastName: sex === "m" ? maleLast : femaleLast, middleName, phone: this.phone() };
  }

  private phone() {
    for (;;) {
      // Коды федеральных операторов по всей стране, без привязки к одному региону.
      const operator = this.rng.pick(["900", "901", "903", "905", "906", "909", "915", "916", "925", "926", "929", "950", "951", "960", "961", "965", "977", "985", "999"]);
      const number = `+7 ${operator} ${this.rng.int(100, 999)}-${String(this.rng.int(0, 99)).padStart(2, "0")}-${String(this.rng.int(0, 99)).padStart(2, "0")}`;
      if (!this.usedPhones.has(number)) {
        this.usedPhones.add(number);
        return number;
      }
    }
  }

  private plate() {
    for (;;) {
      const letter = () => PLATE_LETTERS[this.rng.int(0, PLATE_LETTERS.length - 1)];
      const digits = String(this.rng.int(1, 999)).padStart(3, "0");
      const plate = `${letter()}${digits}${letter()}${letter()}${this.rng.pick(PLATE_REGIONS)}`;
      if (!this.usedPlates.has(plate)) {
        this.usedPlates.add(plate);
        return plate;
      }
    }
  }

  private car() {
    const car = this.rng.weighted(CAR_MODELS, (item) => item.weight);
    return {
      car,
      radius: this.rng.pick(car.radii),
      lowProfile: this.rng.chance(car.lowProfileChance ?? 0),
      runflat: this.rng.chance(car.runflatChance ?? 0),
    };
  }

  private newClientSpec(): NewClientSpec {
    const person = this.person();
    const { car, radius, lowProfile, runflat } = this.car();
    return { person, brand: car.brand, model: car.model, radius, lowProfile, runflat, plateNumber: this.plate() };
  }

  /** Новый клиент — тем же путём, что окно «Новый клиент». */
  private async createPoolClient(
    at: number,
    branchId: string,
    legal?: { name: string; inn: string },
    spec: NewClientSpec = this.newClientSpec(),
  ) {
    const legalCar = legal ? this.rng.pick(CAR_MODELS.filter((item) => item.vehicleType !== "offroad")) : null;
    const car = legalCar ?? CAR_MODELS.find((item) => item.brand === spec.brand && item.model === spec.model) ?? CAR_MODELS[0];
    const radius = legalCar ? this.rng.pick(legalCar.radii) : spec.radius;
    const person = spec.person;
    const created = await runAtDemoTime(at, () =>
      createClient(branchId, {
        ...(legal
          ? { clientKind: "legal" as const, organizationName: legal.name, inn: legal.inn }
          : { fullName: `${person.lastName} ${person.firstName} ${person.middleName}` }),
        phone: person.phone,
        carBrand: car.brand,
        carModel: car.model,
        plateNumber: spec.plateNumber,
        radius,
      }),
    );
    const clientId = (created as { id: string }).id;
    const vehicle = await prisma.vehicle.findFirst({ where: { clientId }, select: { id: true } });
    if (this.rng.chance(0.55)) {
      await prisma.client.update({
        where: { id: clientId },
        data: { source: this.rng.weighted(["интернет", "Яндекс Карты", "2ГИС", "по рекомендации", "проезжали мимо"], (item) => ({ "интернет": 3, "Яндекс Карты": 4, "2ГИС": 2, "по рекомендации": 3, "проезжали мимо": 2 })[item] ?? 1) },
      });
    }
    const pool: PoolClient = {
      id: clientId,
      vehicleId: vehicle?.id ?? null,
      fullName: legal ? legal.name : `${person.lastName} ${person.firstName} ${person.middleName}`,
      phone: person.phone,
      kind: legal ? "legal" : "individual",
      inn: legal?.inn ?? null,
      car,
      radius,
      plateNumber: spec.plateNumber,
      lowProfile: legal ? false : spec.lowProfile,
      runflat: legal ? false : spec.runflat,
      homeBranchId: branchId,
      lastVisit: at,
      storage: null,
    };
    this.clients.push(pool);
    this.stats.clients += 1;
    return pool;
  }

  /** Клиент плана, которого нет в памяти (план сегодняшнего дня после сброса). */
  private async loadClient(clientId: string): Promise<PoolClient | null> {
    const cached = this.clients.find((entry) => entry.id === clientId);
    if (cached) return cached;
    const record = await prisma.client.findUnique({
      where: { id: clientId },
      include: { vehicles: { orderBy: { createdAt: "asc" }, take: 1 }, storageRecords: { where: { status: { not: "Выдано" } }, take: 1 } },
    });
    if (!record || record.archivedAt) return null;
    const vehicle = record.vehicles[0];
    const car = CAR_MODELS.find((item) => item.brand === vehicle?.brand && item.model === vehicle?.model) ?? CAR_MODELS[0];
    const pool: PoolClient = {
      id: record.id,
      vehicleId: vehicle?.id ?? null,
      fullName: record.fullName,
      phone: record.phone,
      kind: record.clientKind === "legal" ? "legal" : "individual",
      inn: record.inn,
      car,
      radius: ((vehicle?.radius || car.radii[0]) as Radius),
      plateNumber: vehicle?.plateNumber ?? "",
      lowProfile: false,
      runflat: false,
      homeBranchId: "",
      lastVisit: 0,
      storage: null,
    };
    this.clients.push(pool);
    return pool;
  }

  private async addFleetVehicle(owner: PoolClient, at: number) {
    const car = this.rng.pick(CAR_MODELS.filter((item) => item.vehicleType === "commercial" || item.vehicleType === "passenger"));
    const plateNumber = this.plate();
    const radius = this.rng.pick(car.radii);
    const vehicle = await prisma.vehicle.create({
      data: {
        id: `vehicle-${this.rng.uuid()}`,
        clientId: owner.id,
        label: `${car.brand} ${car.model} ${plateNumber}`,
        brand: car.brand,
        model: car.model,
        plateNumber,
        radius,
        createdAt: new Date(at),
      },
    });
    this.clients.push({ ...owner, vehicleId: vehicle.id, car, radius, plateNumber, lowProfile: false, runflat: false, storage: null });
  }

  private clientSnapshot(client: PoolClient): DemoOrderClientSnapshot {
    const details = [`${client.car.brand} ${client.car.model}`, client.plateNumber, client.phone].join(" · ");
    return {
      mode: "existing",
      clientId: client.id,
      clientKind: client.kind,
      ...(client.kind === "legal" ? { inn: client.inn ?? undefined, organizationName: client.fullName } : {}),
      label: client.fullName,
      details,
      name: client.fullName,
      phone: client.phone,
      carBrand: client.car.brand,
      carModel: client.car.model,
      plateNumber: client.plateNumber,
      preferredRadius: client.radius,
      notRegisteredInRf: false,
      anonymous: false,
    };
  }

  private anonymousSnapshot(car: { brand: string; model: string }): DemoOrderClientSnapshot {
    return {
      mode: "anonymous",
      clientId: "anonymous",
      clientKind: "individual",
      label: "Анонимный клиент",
      details: `${car.brand} ${car.model}`,
      name: "Анонимный клиент",
      phone: "",
      carBrand: car.brand,
      carModel: car.model,
      plateNumber: "",
      preferredRadius: "",
      notRegisteredInRf: false,
      anonymous: true,
    };
  }

  /* ------------------------------------------------------------ состав */

  private composeLines(
    kind: "season" | "repair" | "balance" | "disk" | "issue" | "sensor" | "studs",
    context: PricingContext,
    withStorage: boolean,
  ): DemoLineRequest[] {
    const lines: DemoLineRequest[] = [];
    const wheels = context.vehicleType === "commercial" && this.rng.chance(0.4) ? 6 : 4;
    switch (kind) {
      case "season":
      case "issue":
        lines.push({ serviceId: "main-package", quantity: wheels });
        if (this.rng.chance(0.42)) lines.push({ serviceId: "washing", quantity: wheels });
        if (this.rng.chance(0.12)) lines.push({ serviceId: "valve-tech", quantity: wheels });
        if (this.rng.chance(0.1)) lines.push({ serviceId: "hub-clean", quantity: wheels });
        if (withStorage) {
          lines.push({ serviceId: "bag", quantity: wheels });
          lines.push({ serviceId: "storage-season", quantity: 1, manualPrice: context.radius >= "R18" ? 3500 : 2800 });
        }
        if (kind === "issue") lines.push({ serviceId: "storage-issue", quantity: 1 });
        break;
      case "repair":
        lines.push({ serviceId: this.rng.pick(["plug", "plug", "patch", "mushroom"]), quantity: 1 });
        lines.push({ serviceId: "installation", quantity: 1 });
        if (this.rng.chance(0.7)) lines.push({ serviceId: "balancing", quantity: 1 });
        if (this.rng.chance(0.2)) lines.push({ serviceId: "airtight-check", quantity: 1 });
        break;
      case "balance":
        lines.push({ serviceId: "installation", quantity: wheels });
        lines.push({ serviceId: "balancing", quantity: wheels });
        if (this.rng.chance(0.3)) lines.push({ serviceId: "wheel-optimization", quantity: 2 });
        break;
      case "disk":
        lines.push({ serviceId: this.rng.pick(["cast-disk", "cast-disk", "steel-disk", "cast-disk-eight"]), quantity: this.rng.int(1, 2), manualPrice: 1200 });
        lines.push({ serviceId: "installation", quantity: 2 });
        lines.push({ serviceId: "balancing", quantity: 2 });
        break;
      case "sensor":
        lines.push({ serviceId: "bh-sensor", quantity: this.rng.int(1, 4) });
        lines.push({ serviceId: "installation", quantity: 2 });
        break;
      case "studs":
        lines.push({ serviceId: "restudding-standard", quantity: this.rng.int(12, 40) });
        break;
    }
    return lines;
  }

  private pickPayment(client: PoolClient | null, total: number): PlannedPayment {
    if (client?.kind === "legal" && this.rng.chance(0.9)) {
      return { method: "bank_account", note: `счёт №${this.rng.int(12, 480)} от ${this.rng.int(1, 28)}.09`, receipt: "none" };
    }
    const method = this.rng.weighted<DemoOrderPaymentMethod>(
      ["card", "cash", "transfer", "owner_transfer"],
      (item) => ({ card: 55, cash: 22, transfer: 18, owner_transfer: total > 6000 ? 5 : 1, bank_account: 0 } as Record<DemoOrderPaymentMethod, number>)[item],
    );
    if (method === "card") return { method, note: "", receipt: "auto" };
    if (method === "owner_transfer") return { method, note: "перевод владельцу", receipt: "none" };
    return { method, note: "", receipt: this.rng.chance(0.86) ? "with_qr" : "without_qr" };
  }

  private accountFor(branchId: string, method: DemoOrderPaymentMethod) {
    if (method === "cash") return { id: `${branchId}-account-cash`, name: "Наличные в кассе" };
    if (method === "transfer" || method === "owner_transfer") return { id: `${branchId}-account-ip`, name: "ИП Соколов А. В." };
    return { id: `${branchId}-account-automation-service`, name: "ООО «Протектор»" };
  }

  private pickReturningClient(branchId: string, at: number, predicate?: (client: PoolClient) => boolean) {
    const candidates = this.clients.filter(
      (client) =>
        at - client.lastVisit > 12 * DAY &&
        (client.homeBranchId === branchId || this.rng.chance(0.15)) &&
        (!predicate || predicate(client)),
    );
    if (candidates.length === 0) return null;
    const picked = this.rng.pick(candidates);
    // Визит резервируется сразу: план дня собирается целиком до заказов, и
    // без этого один клиент приезжал бы несколько раз за день.
    picked.lastVisit = at;
    return picked;
  }

  /* ------------------------------------------------------------ план дня */

  private planDay(branch: DemoBranch, dayKey: string, isToday: boolean) {
    const dow = weekday(dayKey);
    // Нагрузка дня: ритм недели × поток точки × небольшой разброс дня.
    const intensity = WEEKDAY_INTENSITY[dow] * branch.traffic * (1 + this.rng.normal(0, 0.03, -0.06, 0.06));
    const openMinute = 8 * 60 + 50 + this.rng.int(0, 12);
    const closeMinute = 21 * 60 + this.rng.int(0, 14);
    const masters = demoMastersForBranch(branch.id);
    const working = masters.filter(() => this.rng.chance(0.85));
    while (working.length < Math.min(2, masters.length)) {
      const extra = masters.find((master) => !working.includes(master));
      if (!extra) break;
      working.push(extra);
    }
    const staffIds = [demoAdminForBranch(branch.id).id, ...working.map((master) => master.id)];

    const orders: PlannedOrder[] = [];
    const masterIds = working.map((master) => master.id);
    // Любой день — и сегодняшний, и дни истории — строится одинаково,
    // по постам: на первом машины идут одна за другой весь день (в любой
    // момент рабочего дня на точке есть машина в работе), второй пост берёт
    // часы пик — до обеда и после работы. Чем оживлённее день, тем короче
    // паузы и длиннее часы пик второго поста. Сегодняшний день поэтому
    // сравним с тем же днём прошлой недели «к тому же часу».
    const dayStart = localMoment(dayKey, 0).getTime();
    const minuteOf = (at: number) => Math.round((at - dayStart) / MINUTE);
    // Последняя машина уезжает до закрытия смены: иначе смена закроется, а
    // заказ так и останется «в работе» на весь вечер.
    const lastFinish = closeMinute - 10;
    const runPost = (fromMinute: number, untilMinute: number, gap: () => number) => {
      let minute = fromMinute;
      while (minute <= untilMinute - 20) {
        const order = this.planOrder(branch, dayKey, minute, masterIds, isToday);
        if (minuteOf(order.finishAt) > lastFinish) {
          if (lastFinish - minute < 20) break;
          order.finishAt = localMoment(dayKey, lastFinish).getTime();
        }
        orders.push(order);
        minute = minuteOf(order.finishAt) + gap();
      }
    };
    // Первый пост без пауз: пауза в нём — минута, когда на точке пусто.
    runPost(openMinute + 10, lastFinish, () => 0);
    // Ритм недели — на втором посту: в оживлённый день пики длиннее, а паузы короче.
    const peakGap = () => this.rng.int(4, 14) + Math.round(Math.max(0, 1.3 - intensity) * 60);
    const peakLength = Math.round(Math.min(1.6, Math.max(0.6, intensity)) * 120);
    runPost(openMinute + this.rng.int(50, 80), Math.min(13 * 60 + 20, openMinute + 80 + peakLength), peakGap);
    runPost(Math.max(15 * 60, closeMinute - 70 - Math.round(peakLength * 1.6)), closeMinute - 45, peakGap);
    orders.sort((left, right) => left.startAt - right.startAt);

    const expenses = Array.from({ length: this.rng.chance(0.55) ? this.rng.int(1, 2) : 0 }, () => {
      const expense = this.rng.pick(SHIFT_EXPENSES);
      return {
        branchId: branch.id,
        at: localMoment(dayKey, this.rng.int(10 * 60, 19 * 60)).getTime(),
        amount: Math.round(this.rng.int(expense.min, expense.max) / 10) * 10,
        description: expense.description,
      };
    });

    return {
      shift: {
        branchId: branch.id,
        openAt: localMoment(dayKey, openMinute).getTime(),
        closeAt: localMoment(dayKey, closeMinute).getTime(),
        staffIds,
      },
      orders,
      expenses,
    };
  }

  private planOrder(
    branch: DemoBranch,
    dayKey: string,
    startMinute: number,
    masterIds: string[],
    isToday: boolean,
  ): PlannedOrder {
    this.orderSequence += 1;
    const startAt = localMoment(dayKey, startMinute).getTime();
    const kind = this.rng.weighted(
      ["season", "repair", "balance", "disk", "sensor", "studs"] as const,
      (item) => ORDER_KIND_WEIGHTS[item],
    );

    // Клиент: постоянный, новый, юрлицо или без карточки.
    let client: PoolClient | null = null;
    let anonymousCar: PlannedOrder["anonymousCar"] = null;
    let storageRelease: string | null = null;
    let finalKind: typeof kind | "issue" = kind;
    const roll = this.rng.next();

    if (kind === "season" && this.rng.chance(0.3)) {
      const holder = this.pickReturningClient(branch.id, startAt, (item) => item.storage?.season === "winter" && item.storage.branchId === branch.id);
      if (holder && holder.storage) {
        client = holder;
        storageRelease = holder.storage.recordId;
        finalKind = "issue";
      }
    }
    if (!client) {
      if (roll < 0.07) {
        const car = this.rng.weighted(CAR_MODELS, (item) => item.weight);
        anonymousCar = { brand: car.brand, model: car.model };
      } else if (roll < 0.13) {
        client = this.pickReturningClient(branch.id, startAt, (item) => item.kind === "legal") ?? null;
      } else if (roll < 0.62) {
        client = this.pickReturningClient(branch.id, startAt) ?? null;
      }
    }

    // Новый клиент: человек и машина придуманы здесь, карточка заводится при заказе.
    const newClient = !client && !anonymousCar ? this.newClientSpec() : null;
    const context: PricingContext = client
      ? { vehicleType: client.car.vehicleType, radius: client.radius, lowProfile: client.lowProfile, runflat: client.runflat }
      : newClient
        ? {
            vehicleType: CAR_MODELS.find((item) => item.brand === newClient.brand && item.model === newClient.model)?.vehicleType ?? "passenger",
            radius: newClient.radius,
            lowProfile: newClient.lowProfile,
            runflat: newClient.runflat,
          }
        : (() => {
            const anonymousModel = CAR_MODELS.find((item) => item.brand === anonymousCar!.brand && item.model === anonymousCar!.model)!;
            return { vehicleType: anonymousModel.vehicleType, radius: this.rng.pick(anonymousModel.radii), lowProfile: false, runflat: false };
          })();

    const withStorage = (finalKind === "season" || finalKind === "issue") && this.rng.chance(0.22);
    const lines = this.composeLines(finalKind, context, withStorage);
    const duration =
      finalKind === "season" || finalKind === "issue"
        ? this.rng.int(35, 70)
        : finalKind === "studs"
          ? this.rng.int(40, 90)
          : this.rng.int(20, 45);
    // Двое мастеров — только на шиномонтажных строках: у них общая матрица
    // зарплаты; для остальных услуг система честно просит проверить расчёт.
    const allMatrix = lines.every((line) => MATRIX_SERVICES.has(line.serviceId));
    const executorCount = allMatrix && masterIds.length > 1 && this.rng.chance(finalKind === "season" ? 0.35 : 0.12) ? 2 : 1;
    const executorIds = this.rng.shuffle(masterIds).slice(0, Math.max(1, Math.min(executorCount, masterIds.length)));
    const discountPercent = this.rng.chance(0.06) ? this.rng.pick([5, 10]) : 0;
    // Случайные долги — только в днях старше трёх: к сегодняшнему дню они
    // погашены. Висит ровно один свежий долг (`simulateClosedDay`).
    const debt = !isToday && dayKey < addDays(this.todayKey, -3) && this.rng.chance(0.012);
    const pickedPayment = debt ? null : this.pickPayment(client, 3000);
    // «без чека» (выбор «без QR» у наличных и перевода) — только
    // вчера и сегодня: в «Оплатах без чека» у касс короткий свежий список дел,
    // а не 250 строк за всю историю.
    const payment =
      pickedPayment && pickedPayment.receipt === "without_qr" && dayKey < addDays(this.todayKey, -1)
        ? { ...pickedPayment, receipt: "with_qr" as const }
        : pickedPayment;

    const season = "summer" as const;
    const tireBrand = this.rng.pick(TIRE_BRANDS_SUMMER);
    const size = this.rng.pick(TIRE_SIZE_BY_RADIUS[context.radius] ?? ["205/55"]);

    return {
      id: `plan-${dayKey}-${branch.code}-${this.orderSequence}`,
      branchId: branch.id,
      startAt,
      finishAt: startAt + duration * MINUTE,
      clientId: client?.id ?? null,
      newClient,
      anonymousCar,
      context,
      lines,
      discountPercent,
      executorIds,
      payment,
      payLaterAt: debt ? startAt + this.rng.int(1, 3) * DAY + 3 * 60 * MINUTE : null,
      storageRelease,
      storageAccept: withStorage
        ? { season, label: `Летние шины ${tireBrand} ${size} ${context.radius}` }
        : null,
      markForDeletion: false,
    };
  }

  /* --------------------------------------------------------- исполнение */

  private async openShift(branchId: string, at: number, staffIds: string[]): Promise<ShiftContext | null> {
    const admin = demoAdminForBranch(branchId);
    await runAtDemoTime(at, () =>
      openShiftForBranch({
        branchId,
        actorEmployeeId: admin.id,
        employees: staffIds.map((id) => ({ id })),
      }),
    );
    const context = await this.openShiftContext(branchId);
    if (context) this.stats.shifts += 1;
    return context;
  }

  private async closeShift(branchId: string, shift: ShiftContext, at: number) {
    const admin = demoAdminForBranch(branchId);
    await runAtDemoTime(at, () => closeShiftForBranch({ branchId, shiftId: shift.id, actorEmployeeId: admin.id }));
  }

  /** Создать заказ «В работе» (клиент заводится тут же, если он новый). */
  async createPlannedOrder(item: PlannedOrder, shift: ShiftContext): Promise<{ orderId: string; client: PoolClient | null } | null> {
    let client = item.clientId ? await this.loadClient(item.clientId) : null;
    if (!client && item.newClient) {
      client = await this.timed("клиент: новый", () => this.createPoolClient(item.startAt - 2 * MINUTE, item.branchId, undefined, item.newClient!));
      item.clientId = client.id;
    }
    if (!client && !item.anonymousCar) return null;

    const lines = item.lines
      .map((line) => buildDemoCartItem(this.catalog, line, item.context))
      .filter((line): line is NonNullable<typeof line> => Boolean(line));
    if (lines.length === 0) return null;

    let executorIds = item.executorIds.filter((id) => shift.labels.has(id));
    if (executorIds.length === 0) {
      const onShift = [...shift.labels.keys()].filter((id) => DEMO_EMPLOYEES.find((employee) => employee.id === id)?.canBeAssignedExecutor);
      executorIds = onShift.slice(0, 1);
      item.executorIds = executorIds;
    }
    const snapshot = buildWorkingOrderSnapshot({
      client: client ? this.clientSnapshot(client) : this.anonymousSnapshot(item.anonymousCar!),
      context: item.context,
      lines,
      discountPercent: item.discountPercent,
      executorIds,
      executorLabel: executorIds[0] ? shift.labels.get(executorIds[0]) ?? null : null,
      createdAt: new Date(item.startAt),
      internalComment: item.internalComment,
    });

    const created = await this.timed("заказ: запись создания", () => runAtDemoTime(item.startAt, () => createOrderForBranch(item.branchId, snapshot)));
    const orderId = (created as { order?: DemoOrder } | null)?.order?.id;
    if (!orderId) return null;
    if (client) client.lastVisit = item.startAt;
    this.stats.orders += 1;
    return { orderId, client };
  }

  /** Провести заказ: оплата (с чеком) или «Выполнен» в долг. */
  async completePlannedOrder(item: PlannedOrder, orderId: string, shift: ShiftContext, knownClient: PoolClient | null) {
    const client = knownClient ?? (item.clientId ? await this.loadClient(item.clientId) : null);
    const current = await runAtDemoTime(item.finishAt, async () => {
      const { getOrderByIdForBranch } = await import("@/server/repositories/order-read-repository");
      return getOrderByIdForBranch(item.branchId, orderId);
    });
    const saved = (current as { order?: DemoOrder } | null)?.order;
    if (!saved) return;
    const executorIds = item.executorIds.filter((id) => shift.labels.has(id));
    const payment = item.payment
      ? { method: item.payment.method, ...this.accountFor(item.branchId, item.payment.method), note: item.payment.note }
      : null;
    const conducted = buildConductedOrderSnapshot(
      {
        ...saved,
        executorEmployeeIds: executorIds,
        executorId: executorIds[0] ?? null,
        executorEmployeeId: executorIds[0] ?? null,
        shiftId: shift.id,
        shiftLabelSnapshot: formatShiftLabel(shift.number, shift.openedAt),
        shiftOpenedAtSnapshot: shift.openedAt,
      },
      {
        at: new Date(item.finishAt),
        payment: payment ? { method: payment.method, accountId: payment.id, accountName: payment.name, note: payment.note } : null,
      },
    );
    await this.timed("заказ: запись оплаты", () => runAtDemoTime(item.finishAt, () => updateOrderForBranch(item.branchId, orderId, conducted)));
    if (payment) this.stats.payments += 1;

    if (payment && this.kkmReceipts && (item.payment?.receipt === "with_qr" || item.payment?.receipt === "without_qr")) {
      await this.timed("касса: чек по выбору", () => this.chooseReceipt(item.branchId, orderId, item.payment!.receipt as "with_qr", item.finishAt + MINUTE));
    }

    if (item.storageRelease) {
      await runAtDemoTime(item.finishAt + MINUTE, () =>
        updateStorageRecordForBranch(item.branchId, item.storageRelease!, { release: true }),
      ).catch((error) => this.fail("выдача с хранения", error));
      if (client) client.storage = null;
    }
    if (item.storageAccept && client) {
      await this.acceptStorage(item.branchId, client, item.storageAccept.label, "summer", item.finishAt + 2 * MINUTE);
    }
  }

  private async chooseReceipt(branchId: string, orderId: string, choice: "with_qr" | "without_qr", at: number) {
    const payments = await prisma.payment.findMany({ where: { orderId }, select: { id: true } });
    const admin = demoAdminForBranch(branchId);
    if (choice !== "with_qr") return;
    await runAtDemoTime(at, () =>
      createKkmOperationByChoiceForBranch({
        branchId,
        orderId,
        operationId: this.rng.uuid(),
        kind: "sale",
        printDocument: null,
        paymentIds: payments.map((payment) => payment.id),
        actorEmployeeId: admin.id,
      }),
    ).catch((error) => this.fail("чек по выбору", error));
  }

  /* ------------------------------------------------------------ хранение */

  private nextStorageNumber(branch: DemoBranch) {
    const next = (this.storageCounters.get(branch.id) ?? 100) + this.rng.int(1, 3);
    this.storageCounters.set(branch.id, next);
    return `${branch.storagePrefix}-${String(next).padStart(4, "0")}`;
  }

  private freeCell(branch: DemoBranch) {
    const taken = this.occupiedCells.get(branch.id) ?? new Set<string>();
    this.occupiedCells.set(branch.id, taken);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const shelf = this.rng.int(1, branch.shelves);
      const cell = this.rng.int(1, branch.cells);
      const key = `${shelf}:${cell}`;
      if (!taken.has(key)) {
        taken.add(key);
        return { shelf: String(shelf), cell: String(cell) };
      }
    }
    return null;
  }

  private async acceptStorage(branchId: string, client: PoolClient, label: string, season: "winter" | "summer", at: number) {
    const branch = DEMO_BRANCHES.find((item) => item.id === branchId)!;
    const place = this.freeCell(branch);
    if (!place) return;
    try {
      const record = await runAtDemoTime(at, () =>
        createStorageRecordForBranch(branchId, {
          storageNumber: this.nextStorageNumber(branch),
          clientId: client.id,
          clientName: client.fullName,
          clientPhone: client.phone,
          carBrand: client.car.brand,
          carModel: client.car.model,
          plateNumber: client.plateNumber,
          kitLabel: label,
          warehouseId: `warehouse-${branch.code}`,
          warehouseName: `Склад «${branch.name}»`,
          shelfLabel: place.shelf,
          cellLabel: place.cell,
          note: season === "winter" ? (this.rng.chance(0.6) ? "Комплект на дисках" : "") : "",
        }),
      );
      const id = (record as { id?: string }).id;
      if (id) {
        client.storage = { recordId: id, branchId, season };
        this.stats.storage += 1;
      }
    } catch (error) {
      this.fail("приём на хранение", error);
    }
  }

  /* ------------------------------------------------------------- записи */

  private async createBooking(
    branchId: string,
    dayKey: string,
    startMinute: number,
    lengthMinutes: number,
    postIndex: number,
    params: { client: PoolClient | null; online: boolean; createdAt: number; comment: string },
  ) {
    const start = hhmm(startMinute);
    const end = hhmm(startMinute + lengthMinutes);
    const segment = { id: `seg-${this.rng.uuid()}`, postId: `post-${postIndex}`, postName: `Пост ${postIndex}`, start, end };
    try {
      if (params.online) {
        const person = params.client ? { name: params.client.fullName.split(" ").slice(0, 2).reverse().join(" "), phone: params.client.phone } : (() => {
          const guest = this.person();
          return { name: `${guest.firstName} ${guest.lastName}`, phone: guest.phone };
        })();
        const entries = await runAtDemoTime(params.createdAt, () =>
          createBookingGroupForBranch(branchId, {
            date: dayKey,
            note: params.comment,
            segments: [segment],
            createdByEmployeeId: null,
            serviceLabel: "Онлайн-запись",
            clientName: person.name,
            clientPhone: person.phone,
          }),
        );
        this.noteBooking(entries, params.createdAt);
      } else {
        const entries = await runAtDemoTime(params.createdAt, () =>
          createBookingGroupForBranch(branchId, {
            date: dayKey,
            clientId: params.client?.id ?? null,
            note: params.comment,
            segments: [segment],
            createdByEmployeeId: demoAdminForBranch(branchId).id,
          }),
        );
        this.noteBooking(entries, params.createdAt);
      }
      this.stats.bookings += 1;
    } catch (error) {
      this.fail("запись", error);
    }
  }

  private noteBooking(entries: Array<{ groupId?: string }>, createdAt: number) {
    const groupId = entries[0]?.groupId;
    if (groupId) this.options.onBooking?.(groupId, createdAt);
  }

  /** Записи дня: часть заказов пришла по записи, часть записей — неявки. */
  private async bookDay(branchId: string, dayKey: string, orders: PlannedOrder[], share: number) {
    const postBusyUntil = [0, 0, 0, 0];
    for (const order of orders) {
      if (!this.rng.chance(share)) continue;
      const startMinute = Math.round((order.startAt - localMoment(dayKey, 0).getTime()) / MINUTE / 15) * 15;
      const length = Math.max(30, Math.round((order.finishAt - order.startAt) / MINUTE / 15) * 15);
      const post = [1, 2, 3].find((index) => postBusyUntil[index] <= startMinute) ?? this.rng.int(1, 3);
      postBusyUntil[post] = startMinute + length;
      const client = order.clientId ? this.clients.find((item) => item.id === order.clientId) ?? null : null;
      const online = this.rng.chance(0.38);
      await this.createBooking(branchId, dayKey, startMinute, length, post, {
        client,
        online: online || !client,
        createdAt: order.startAt - this.rng.int(1, 6) * DAY + this.rng.int(-240, 240) * MINUTE,
        comment: this.rng.pick(BOOKING_COMMENTS),
      });
    }
  }

  /** Записи на будущие дни: клиенты уже записались на переобувку. */
  private async bookFuture(branch: DemoBranch, dayKey: string, daysAhead: number, nowAt: number) {
    const expected = FUTURE_BOOKINGS_BASE[weekday(dayKey)] * branch.traffic * 1.4 * Math.max(0.12, 0.62 - daysAhead * 0.045);
    const count = this.rng.poisson(expected);
    const busy = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const startMinute = Math.round(this.rng.normal(14 * 60, 170, 9 * 60, 20 * 60) / 15) * 15;
      const length = this.rng.pick([30, 45, 45, 60, 60]);
      const post = this.rng.int(1, 3);
      const key = `${post}:${startMinute}`;
      if (busy.has(key)) continue;
      busy.add(key);
      const online = this.rng.chance(0.42);
      const client = online ? null : this.pickReturningClient(branch.id, nowAt) ?? null;
      await this.createBooking(branch.id, dayKey, startMinute, length, post, {
        client,
        online: online || !client,
        createdAt: nowAt - this.rng.int(1, 5 * 24 * 60) * MINUTE,
        comment: this.rng.pick(BOOKING_COMMENTS),
      });
    }
  }

  /* ------------------------------------------------------------- этапы */

  /** Постоянные клиенты, юрлица и весеннее хранение — до начала истории. */
  async seedClientBase() {
    const historyStart = localMoment(addDays(this.todayKey, -this.options.historyDays), 9 * 60).getTime();

    for (const legal of LEGAL_CLIENTS) {
      const branch = this.rng.pick(DEMO_BRANCHES);
      const owner = await this.createPoolClient(historyStart - this.rng.int(120, 400) * DAY, branch.id, legal);
      for (let index = 0; index < this.rng.int(1, 3); index += 1) {
        await this.addFleetVehicle(owner, owner.lastVisit + this.rng.int(1, 60) * DAY);
      }
    }

    // Весна: клиенты оставили зимние комплекты до осени.
    for (const branch of DEMO_BRANCHES) {
      const count = Math.round(branch.shelves * branch.cells * 0.42);
      for (let index = 0; index < count; index += 1) {
        const springDay = addDays(this.todayKey, -this.rng.int(140, 170));
        const at = localMoment(springDay, this.rng.int(10 * 60, 19 * 60)).getTime();
        const client = await this.createPoolClient(at - 5 * MINUTE, branch.id);
        client.lastVisit = at - 60 * DAY;
        const brand = this.rng.pick(TIRE_BRANDS_WINTER);
        const size = this.rng.pick(TIRE_SIZE_BY_RADIUS[client.radius] ?? ["205/55"]);
        await this.acceptStorage(branch.id, client, `Зимние шины ${brand} ${size} ${client.radius}`, "winter", at);
      }
      this.progress(0.02 + 0.02 * DEMO_BRANCHES.indexOf(branch), "Клиенты и хранение");
    }
  }

  /** Дни истории: смены, заказы, оплаты, записи, расходы, инкассация. */
  async generateHistory() {
    const days = this.options.historyDays;
    for (let offset = days; offset >= 1; offset -= 1) {
      const dayKey = addDays(this.todayKey, -offset);
      for (const branch of DEMO_BRANCHES) {
        await this.simulateClosedDay(branch, dayKey);
      }
      this.progress(0.06 + 0.84 * ((days - offset + 1) / days), `История: ${dayKey}`);
    }
  }

  private async simulateClosedDay(branch: DemoBranch, dayKey: string) {
    const plan = this.planDay(branch, dayKey, false);
    if (dayKey === addDays(this.todayKey, -1) && branch.id === DEMO_BRANCHES[0].id) {
      // Вчерашний заказ юрлица выполнен в долг: оплата — по счёту, позже.
      const isLegal = (order: PlannedOrder) => this.clients.find((client) => client.id === order.clientId)?.kind === "legal";
      const debtor =
        plan.orders.find((order) => isLegal(order) && !order.storageRelease) ??
        plan.orders.find((order) => order.clientId && !order.storageRelease && !order.storageAccept);
      if (debtor) {
        debtor.payment = null;
        debtor.payLaterAt = null;
      }
    }
    // Записи — только за последние четыре недели истории:
    // экран записи отдаёт все записи точки прямо в документе, а старые записи
    // посетителю не видны, только утяжеляли первую загрузку.
    if (dayKey >= addDays(this.todayKey, -BOOKING_HISTORY_DAYS)) {
      await this.timed("записи", () => this.bookDay(branch.id, dayKey, plan.orders, 0.45));
    }

    let shift: ShiftContext | null = null;
    try {
      shift = await this.timed("смена: открытие", () => this.openShift(branch.id, plan.shift.openAt, plan.shift.staffIds));
    } catch (error) {
      this.fail(`смена ${branch.code} ${dayKey}`, error);
      return;
    }
    if (!shift) return;

    type Event = { at: number; run: () => Promise<void> };
    const events: Event[] = [];
    const created = new Map<string, { orderId: string; client: PoolClient | null }>();

    for (const order of plan.orders) {
      events.push({
        at: order.startAt,
        run: async () => {
          const result = await this.timed("заказ: создание", () => this.createPlannedOrder(order, shift!));
          if (result) created.set(order.id, result);
        },
      });
      events.push({
        at: order.finishAt,
        run: async () => {
          const result = created.get(order.id);
          if (result) await this.timed("заказ: проведение", () => this.completePlannedOrder(order, result.orderId, shift!, result.client));
        },
      });
    }
    for (const expense of plan.expenses) {
      events.push({
        at: expense.at,
        run: async () => {
          await runAtDemoTime(expense.at, () =>
            addShiftExpenseForBranch({
              branchId: branch.id,
              shiftId: shift!.id,
              actorEmployeeId: demoAdminForBranch(branch.id).id,
              amount: expense.amount,
              description: expense.description,
            }),
          );
        },
      });
    }
    events.sort((left, right) => left.at - right.at);

    for (const event of events) {
      try {
        await event.run();
      } catch (error) {
        this.fail(`${branch.code} ${dayKey}`, error);
      }
    }

    // Долги прошлых дней, которые клиент гасит сегодня.
    await this.settleDebts(branch.id, plan.shift.openAt, plan.shift.closeAt, shift);

    // Инкассация по понедельникам и четвергам.
    const dow = weekday(dayKey);
    if (dow === 1 || dow === 4) {
      await this.collectCash(branch.id, plan.shift.closeAt - 20 * MINUTE);
    }

    if (this.kkmReceipts) await this.timed("касса: печать", () => this.printPendingReceipts(branch.id, plan.shift.closeAt - 5 * MINUTE));

    try {
      await this.timed("смена: закрытие", () => this.closeShift(branch.id, shift!, plan.shift.closeAt));
    } catch (error) {
      this.fail(`закрытие смены ${branch.code} ${dayKey}`, error);
    }

    // Отложенные оплаты долгов этого дня.
    for (const order of plan.orders) {
      const result = created.get(order.id);
      if (order.payLaterAt && result) this.debts.push({ branchId: branch.id, orderId: result.orderId, at: order.payLaterAt });
    }
  }

  private readonly debts: Array<{ branchId: string; orderId: string; at: number }> = [];

  private async settleDebts(branchId: string, from: number, to: number, shift: ShiftContext) {
    // Долг гасится в первую смену точки после срока: срок мог выпасть на вечер
    // после закрытия — тогда клиент платит на следующий день.
    const due = this.debts.filter((debt) => debt.branchId === branchId && debt.at <= to);
    for (const debt of due) {
      this.debts.splice(this.debts.indexOf(debt), 1);
      debt.at = Math.min(Math.max(debt.at, from + 90 * MINUTE), to - 45 * MINUTE);
      const order = await prisma.order.findUnique({ where: { id: debt.orderId }, select: { totalAmount: true } });
      if (!order) continue;
      const total = Number(order.totalAmount);
      const account = this.accountFor(branchId, "card");
      try {
        await runAtDemoTime(debt.at, () =>
          appendPaymentForOrderBranch(branchId, debt.orderId, {
            operationId: this.rng.uuid(),
            payment: {
              paymentStatus: "Оплачен",
              paymentMethod: "card",
              paymentLabel: PAYMENT_LABELS.card,
              accountId: account.id,
              accountNameSnapshot: account.name,
              paidAt: new Date(debt.at).toISOString(),
              paidAmount: total,
              paidTotal: total,
              remainingAmount: 0,
              note: "",
              internalComment: null,
            },
            shiftId: shift.id,
            shiftLabelSnapshot: formatShiftLabel(shift.number, shift.openedAt),
            shiftOpenedAtSnapshot: shift.openedAt,
          }),
        );
        this.stats.payments += 1;
      } catch (error) {
        this.fail("оплата долга", error);
      }
    }
  }

  private async collectCash(branchId: string, at: number) {
    try {
      const dayKey = dayKeyOf(new Date(at));
      const state = await getBranchCashCollectionState(branchId, { from: dayKey, to: dayKey });
      const availableCents = state.availableCents;
      const amountCents = Math.floor((availableCents * this.rng.int(70, 95)) / 100 / 100000) * 100000;
      if (amountCents <= 0) return;
      const owner = DEMO_EMPLOYEES[0];
      await createCashCollectionForBranch({
        branchId,
        actorEmployeeId: owner.id,
        actorNameSnapshot: `${owner.lastName} ${owner.firstName.slice(0, 1)}.`,
        operationId: this.rng.uuid(),
        amountCents,
        collectedAt: new Date(at),
      });
    } catch (error) {
      this.fail("инкассация", error);
    }
  }

  /** Демо-касса «печатает» всё, что стоит в очереди точки. */
  async printPendingReceipts(branchId: string, at: number) {
    for (let round = 0; round < 40; round += 1) {
      const pending = await prisma.kkmOperation.count({ where: { branchId, status: { in: ["created", "leased", "in_progress"] } } });
      if (pending === 0) return;
      await runAtDemoTime(at + round * 1000, () => runKkmDemoHelper([branchId]));
    }
  }

  /** Записи на сегодня и вперёд. */
  async generateFutureBookings(todayPlan: TodayPlan) {
    const nowAt = this.options.now.getTime();
    for (const branch of DEMO_BRANCHES) {
      const todays = todayPlan.orders.filter((order) => order.branchId === branch.id);
      await this.bookDay(branch.id, this.todayKey, todays, 0.62);
      for (let ahead = 1; ahead <= this.options.futureDays; ahead += 1) {
        await this.bookFuture(branch, addDays(this.todayKey, ahead), ahead, nowAt);
      }
    }
  }

  /** План сегодняшнего дня: его по часам проводит `advanceDemoToday`. */
  planToday(): TodayPlan {
    const plan: TodayPlan = { dayKey: this.todayKey, shifts: [], orders: [], expenses: [] };
    for (const branch of DEMO_BRANCHES) {
      const day = this.planDay(branch, this.todayKey, true);
      plan.shifts.push(day.shift);
      plan.orders.push(...day.orders);
      plan.expenses.push(...day.expenses);
    }
    plan.orders.sort((left, right) => left.startAt - right.startAt);
    return plan;
  }

  /** Вчерашний заказ в очереди на удаление — ждёт решения владельца. */
  async markRecentOrdersForDeletion() {
    const yesterday = getOperationalDayRange(addDays(this.todayKey, -1));
    const candidates = await prisma.order.findMany({
      where: { createdAt: { gte: yesterday.start, lt: yesterday.endExclusive }, status: "Оплачен" },
      select: { id: true, branchId: true, createdAt: true },
      take: 1,
      orderBy: { createdAt: "desc" },
    });
    for (const order of candidates) {
      const admin = demoAdminForBranch(order.branchId);
      await runAtDemoTime(order.createdAt.getTime() + 3 * 60 * MINUTE, () =>
        markOrderForDeletion(order.branchId, order.id, {
          employeeId: admin.id,
          userId: null,
          name: `${admin.lastName} ${admin.firstName.slice(0, 1)}.`,
        }),
      ).catch((error) => this.fail("пометка на удаление", error));
    }
  }

  get clientPool() {
    return this.clients;
  }

  /* ------------------------------------------- для плана сегодняшнего дня */

  openShiftAt(branchId: string, at: number, staffIds: string[]) {
    return this.openShift(branchId, at, staffIds);
  }

  /** Открытая смена точки (кем бы она ни была открыта) — для заказов плана. */
  async openShiftContext(branchId: string): Promise<ShiftContext | null> {
    const shift = await prisma.shift.findFirst({
      where: { branchId, status: "open" },
      orderBy: { openedAt: "desc" },
      select: { id: true, number: true, openedAt: true, staff: { select: { employeeId: true, employeeNameSnapshot: true } } },
    });
    if (!shift) return null;
    const labels = new Map(shift.staff.filter((row) => row.employeeId).map((row) => [row.employeeId!, row.employeeNameSnapshot]));
    return { id: shift.id, number: shift.number, openedAt: shift.openedAt.toISOString(), staffIds: [...labels.keys()], labels };
  }

  async addExpenseAt(expense: { branchId: string; at: number; amount: number; description: string }, shift: ShiftContext) {
    await runAtDemoTime(expense.at, () =>
      addShiftExpenseForBranch({
        branchId: expense.branchId,
        shiftId: shift.id,
        actorEmployeeId: demoAdminForBranch(expense.branchId).id,
        amount: expense.amount,
        description: expense.description,
      }),
    );
  }
}
