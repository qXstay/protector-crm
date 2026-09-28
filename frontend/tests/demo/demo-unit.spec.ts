import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { matchDemoScenario } from "../../src/features/demo/config";
import { compactNameList, countLabel, formatDelta, formatRub, formatShortDate, isWeekend, plural } from "../../src/shared/format";
import { findFirstFreeInterval } from "../../src/features/booking/first-free-interval";
import { dayKeyFromDateLabel, fillPeriodDays, previousPeriod, sharePercent, showcaseDefaultFromKey } from "../../src/features/analytics/showcase-days";
import type { BookingEntry, BookingPost } from "../../src/features/booking/types";
import { DemoRandom } from "../../src/server/demo/random";
import { lastVisitorActivityAt, noteVisitorSeen, noteVisitorWrite } from "../../src/server/demo/activity";
import { demoRateLimit } from "../../src/server/demo/rate-limit";
import { setDemoClockOffset } from "../../src/server/demo/clock";
import { demoClockNearClosing, shotClockSetting, workdayClockEnabled, workdayClockOffset } from "../../src/server/demo/workday-clock";
import { demoClockScript } from "../../src/lib/demo-clock-script";

/** Чистые проверки витрины: форматы экранов, отметка сценариев, генератор случайностей. */

/** Intl ставит между разрядами узкий неразрывный пробел — для сравнения он обычный. */
const plain = (text: string | undefined) => (text ?? "").replace(/\s/g, " ");

test("деньги без лишних копеек, даты «25 сент.», окончания у чисел", () => {
  expect(plain(formatRub(1234))).toBe("1 234 ₽");
  expect(plain(formatRub(1234.5))).toBe("1 234,50 ₽");
  expect(plain(formatRub(0))).toBe("0 ₽");
  expect(formatShortDate("2026-09-25")).toBe("25 сент.");
  expect(plural(1, ["заказ", "заказа", "заказов"])).toBe("заказ");
  expect(plural(3, ["заказ", "заказа", "заказов"])).toBe("заказа");
  expect(plural(11, ["заказ", "заказа", "заказов"])).toBe("заказов");
  expect(plural(21, ["заказ", "заказа", "заказов"])).toBe("заказ");
  expect(plain(countLabel(112, ["запись", "записи", "записей"]))).toBe("112 записей");
  expect(isWeekend("2026-09-26")).toBe(true);
  expect(isWeekend("2026-09-25")).toBe(false);
  expect(formatDelta(110, 100)?.text).toBe("+10 %");
  expect(formatDelta(90, 100)?.text).toBe("−10 %");
  expect(formatDelta(90, 0)).toBeNull();
});

test("сценарии плашки отмечаются только успешным завершающим запросом", () => {
  expect(matchDemoScenario("POST", "/api/public/booking/lesnaya-1", {})).toBe("booking");
  expect(matchDemoScenario("POST", "/api/storage-records", {})).toBe("storage");
  expect(matchDemoScenario("POST", "/api/orders/order-1/payments", {})).toBe("order");
  expect(matchDemoScenario("PATCH", "/api/orders/order-1", { order: { status: "Оплачен" } })).toBe("order");
  // Сохранение заказа без оплаты — ещё не сценарий.
  expect(matchDemoScenario("PATCH", "/api/orders/order-1", { order: { status: "В работе" } })).toBeNull();
  expect(matchDemoScenario("GET", "/api/storage-records", null)).toBeNull();
});

test("генератор демо-данных детерминирован: одно зерно — одни данные", () => {
  const first = new DemoRandom("protektor-2026-09-26");
  const second = new DemoRandom("protektor-2026-09-26");
  const other = new DemoRandom("protektor-2026-09-27");
  const run = (random: DemoRandom) => Array.from({ length: 5 }, () => random.int(1, 1000));
  const a = run(first);
  expect(run(second)).toEqual(a);
  expect(run(other)).not.toEqual(a);
  expect(new DemoRandom(7).uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("потолок частоты демо: сброс 4 раза за 10 минут, дальше 429 с Retry-After; адрес — только из доверенного хвоста", () => {
  const previous = process.env.PUBLIC_BOOKING_TRUSTED_PROXY_HOPS;
  process.env.PUBLIC_BOOKING_TRUSTED_PROXY_HOPS = "1";
  try {
    const visitor = new Headers({ "x-forwarded-for": "203.0.113.7" });
    for (let attempt = 0; attempt < 4; attempt += 1) expect(demoRateLimit("reset", visitor, null)).toBeNull();
    const limited = demoRateLimit("reset", visitor, null);
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Соседний адрес и другой вид действия — свои счётчики.
    expect(demoRateLimit("reset", new Headers({ "x-forwarded-for": "203.0.113.8" }), null)).toBeNull();
    expect(demoRateLimit("write", visitor, null)).toBeNull();
    // Подделка слева от доверенного звена не помогает: берётся правое звено.
    expect(demoRateLimit("reset", new Headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" }), null)?.status).toBe(429);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_BOOKING_TRUSTED_PROXY_HOPS;
    else process.env.PUBLIC_BOOKING_TRUSTED_PROXY_HOPS = previous;
  }
  // Без доверенного адреса ключ — сессия, а без сессии потолка нет.
  expect(demoRateLimit("reset", new Headers(), null)).toBeNull();
});

test("потолок частоты витрины — по настоящему времени: сдвиг часов мира окно не растягивает", () => {
  const previous = process.env.PUBLIC_BOOKING_TRUSTED_PROXY_HOPS;
  process.env.PUBLIC_BOOKING_TRUSTED_PROXY_HOPS = "1";
  const visitor = new Headers({ "x-forwarded-for": "203.0.113.77" });
  try {
    // Ночью часы мира на несколько часов впереди; после пересборки сдвиг другой.
    setDemoClockOffset(3 * 3_600_000);
    for (let attempt = 0; attempt < 4; attempt += 1) expect(demoRateLimit("reset", visitor, null)).toBeNull();
    setDemoClockOffset(0);
    const limited = demoRateLimit("reset", visitor, null);
    expect(limited?.status).toBe(429);
    // Окно — 10 минут настоящего времени, а не 10 минут от «будущих» отметок.
    expect(Number(limited?.headers.get("Retry-After"))).toBeLessThanOrEqual(600);
  } finally {
    setDemoClockOffset(0);
    if (previous === undefined) delete process.env.PUBLIC_BOOKING_TRUSTED_PROXY_HOPS;
    else process.env.PUBLIC_BOOKING_TRUSTED_PROXY_HOPS = previous;
  }
});

test("тихая пересборка ждёт и просмотра, и изменения: активность — последнее из двух", () => {
  const previous = process.env.SHOWCASE_DEMO;
  process.env.SHOWCASE_DEMO = "1";
  try {
    const base = Date.now();
    noteVisitorWrite(base - 30 * 60_000);
    noteVisitorSeen(base - 5 * 60_000);
    // Посетитель полчаса назад менял, а 5 минут назад смотрел карточку — считается просмотр.
    expect(lastVisitorActivityAt()).toBe(base - 5 * 60_000);
    noteVisitorWrite(base - 60_000);
    expect(lastVisitorActivityAt()).toBe(base - 60_000);
  } finally {
    if (previous === undefined) delete process.env.SHOWCASE_DEMO;
    else process.env.SHOWCASE_DEMO = previous;
  }
});

/** Настоящий момент по времени точек (UTC+5): «2026-09-27 05:28» → миллисекунды. */
const pointsTime = (stamp: string) => Date.parse(`${stamp.replace(" ", "T")}:00+05:00`);
const minutes = (value: number) => value / 60_000;

test("часы демо-мира: днём настоящие, в остальное время мир встаёт на 14:00 той же даты", () => {
  // Днём (12:00–19:00 по времени точек) сдвига нет.
  expect(workdayClockOffset(pointsTime("2026-09-27 12:00"))).toBe(0);
  expect(workdayClockOffset(pointsTime("2026-09-27 16:45"))).toBe(0);
  expect(workdayClockOffset(pointsTime("2026-09-27 18:59"))).toBe(0);
  // Ночью и утром — вперёд до 14:00 той же даты, в целых минутах.
  expect(minutes(workdayClockOffset(pointsTime("2026-09-27 05:28")))).toBe(8 * 60 + 32);
  expect(minutes(workdayClockOffset(pointsTime("2026-09-27 00:10")))).toBe(13 * 60 + 50);
  expect(workdayClockOffset(pointsTime("2026-09-27 05:28") + 25_000) % 60_000).toBe(0);
  // Вечером — назад на 14:00 той же даты: дата мира не уходит вперёд.
  expect(minutes(workdayClockOffset(pointsTime("2026-09-27 19:00")))).toBe(-5 * 60);
  expect(minutes(workdayClockOffset(pointsTime("2026-09-27 23:50")))).toBe(-(9 * 60 + 50));
  // Сдвинутые часы показывают 14:00 той же даты точек.
  const late = pointsTime("2026-12-31 23:30");
  expect(new Date(late + workdayClockOffset(late)).toISOString()).toBe("2026-12-31T09:00:00.000Z");
  const early = pointsTime("2027-01-01 03:00");
  expect(new Date(early + workdayClockOffset(early)).toISOString()).toBe("2027-01-01T09:00:00.000Z");
  // Выключенные часы — настоящее время; часы съёмки — заданное время в любое время суток.
  expect(workdayClockOffset(pointsTime("2026-09-27 05:28"), { enabled: false })).toBe(0);
  expect(minutes(workdayClockOffset(pointsTime("2026-09-27 16:00"), { shotClock: "14:10" }))).toBe(-(60 + 50));
  expect(minutes(workdayClockOffset(pointsTime("2026-09-27 05:00"), { shotClock: "14:10", enabled: false }))).toBe(9 * 60 + 10);
});

test("часы демо-мира: к вечеру по часам мира пора пересобрать мир", () => {
  expect(demoClockNearClosing(pointsTime("2026-09-27 14:00"))).toBe(false);
  expect(demoClockNearClosing(pointsTime("2026-09-27 19:59"))).toBe(false);
  expect(demoClockNearClosing(pointsTime("2026-09-27 20:00"))).toBe(true);
  expect(demoClockNearClosing(pointsTime("2026-09-27 23:10"))).toBe(true);
  expect(demoClockNearClosing(pointsTime("2026-09-28 08:59"))).toBe(true);
  expect(demoClockNearClosing(pointsTime("2026-09-28 09:00"))).toBe(false);
});

test("часы для съёмки задаются только явно и в боевом запуске их нет", () => {
  expect(shotClockSetting({})).toBeNull();
  expect(shotClockSetting({ SHOWCASE_SHOT_CLOCK: "14:00" })).toBe("14:00");
  expect(shotClockSetting({ SHOWCASE_SHOT_CLOCK: "25:00" })).toBeNull();
  expect(shotClockSetting({ SHOWCASE_SHOT_CLOCK: "днём" })).toBeNull();
  expect(workdayClockEnabled({})).toBe(true);
  expect(workdayClockEnabled({ SHOWCASE_WORKDAY_CLOCK: "0" })).toBe(false);

  // Боевой запуск и будущая выкладка: образ, точка входа, compose и Caddy.
  const root = path.resolve(process.cwd(), "..");
  const launchFiles = [
    "frontend/Dockerfile",
    "frontend/docker-entrypoint.sh",
    ...readdirSync(root).filter((name) => /^docker-compose.*\.ya?ml$/.test(name)),
    ...(existsSync(path.join(root, "deploy")) ? readdirSync(path.join(root, "deploy")).map((name) => `deploy/${name}`) : []),
    ...(existsSync(path.join(root, "frontend/docker")) ? readdirSync(path.join(root, "frontend/docker")).map((name) => `frontend/docker/${name}`) : []),
  ];
  expect(launchFiles.filter((name) => name.startsWith("docker-compose")).length).toBeGreaterThan(0);
  for (const name of launchFiles) {
    const source = readFileSync(path.join(root, name), "utf8");
    expect(source, name).not.toContain("SHOWCASE_SHOT_CLOCK");
    expect(source, name).not.toContain("SHOWCASE_WORKDAY_CLOCK");
  }
});

test("часы демо-мира в браузере: сдвигают только «сейчас», остальные даты как есть", () => {
  const offset = 8 * 3_600_000 + 32 * 60_000;
  const context: { window: Record<string, unknown> } = { window: {} };
  vm.createContext(context);
  vm.runInContext(demoClockScript(offset), context);
  const ShiftedDate = context.window.Date as DateConstructor;
  const RealDate = vm.runInContext("Date", context) as DateConstructor;

  expect(Math.abs(ShiftedDate.now() - offset - RealDate.now())).toBeLessThan(1_000);
  expect(Math.abs(new ShiftedDate().getTime() - offset - RealDate.now())).toBeLessThan(1_000);
  expect(new ShiftedDate(0).getTime()).toBe(0);
  expect(new ShiftedDate(2026, 0, 1).getFullYear()).toBe(2026);
  expect(new ShiftedDate("2026-09-27T09:00:00.000Z").toISOString()).toBe("2026-09-27T09:00:00.000Z");
  expect(ShiftedDate.UTC(2026, 8, 27)).toBe(RealDate.UTC(2026, 8, 27));
  expect(ShiftedDate.parse("2026-09-27T09:00:00.000Z")).toBe(RealDate.parse("2026-09-27T09:00:00.000Z"));
  expect(typeof (ShiftedDate as unknown as () => string)()).toBe("string");
  expect(new ShiftedDate() instanceof ShiftedDate).toBe(true);
  expect((context.window.__demoClock as { offsetMs: number }).offsetMs).toBe(offset);

  // Сдвиг 0 — подмены нет; второй запуск скрипта не сдвигает часы дважды.
  const plainContext: { window: Record<string, unknown> } = { window: {} };
  vm.createContext(plainContext);
  vm.runInContext(demoClockScript(0), plainContext);
  expect(plainContext.window.Date).toBeUndefined();
  vm.runInContext(demoClockScript(offset), context);
  expect(context.window.Date).toBe(ShiftedDate);
});

test("исполнители одной строкой: «Дмитрий В. +3», один — как есть", () => {
  expect(plain(compactNameList("Дмитрий В., Артём З., Никита Е., Тимур А."))).toBe("Дмитрий В. +3");
  expect(plain(compactNameList("Тимур А."))).toBe("Тимур А.");
  expect(plain(compactNameList("Тимур А., Артём З."))).toBe("Тимур А. +1");
});

test("«Новая запись» на компьютере: первое свободное окно — не раньше «сейчас», на любом свободном посту", () => {
  const posts: BookingPost[] = [
    { id: "post-1", label: "Пост 1" },
    { id: "post-2", label: "Пост 2" },
  ];
  const entry = (postId: string, startTime: string, endTime: string) => ({ postId, startTime, endTime }) as BookingEntry;
  const entries = [entry("post-1", "13:00", "14:00"), entry("post-2", "13:00", "13:30")];
  // Сегодня в 12:50: 13:00 занято на обоих постах, в 13:30 свободен второй.
  expect(findFirstFreeInterval({ entries, posts, slotWindowMinutes: 30, fromTime: "12:50" })).toEqual({
    postId: "post-2",
    start: "13:30",
    end: "14:00",
  });
  // Другой день — с начала рабочего дня, первый пост.
  expect(findFirstFreeInterval({ entries, posts, slotWindowMinutes: 60 })).toEqual({ postId: "post-1", start: "09:00", end: "10:00" });
  // Черновик тоже занимает время.
  expect(
    findFirstFreeInterval({
      entries,
      posts,
      slotWindowMinutes: 30,
      fromTime: "13:25",
      draftSegments: [{ id: "d", postId: "post-2", postName: "Пост 2", start: "13:30", end: "14:00" }],
    }),
  ).toEqual({ postId: "post-1", start: "14:00", end: "14:30" });
  // Вечером окон нет.
  expect(findFirstFreeInterval({ entries, posts, slotWindowMinutes: 30, fromTime: "21:30" })).toBeNull();
});

test("аналитика витрины: прошлый период той же длины, доли, дни периода подряд", () => {
  // «Этот месяц» 1–27 сентября сравнивается с 27 днями перед ним.
  expect(previousPeriod("2026-09-01", "2026-09-27")).toEqual({ from: "2026-08-05", to: "2026-08-31" });
  // Один день — вчерашний; неделя — неделя перед ней, через границу месяца и года.
  expect(previousPeriod("2026-09-27", "2026-09-27")).toEqual({ from: "2026-09-26", to: "2026-09-26" });
  expect(previousPeriod("2027-01-01", "2027-01-07")).toEqual({ from: "2026-12-25", to: "2026-12-31" });
  expect(sharePercent(55, 100)).toBe("55 %");
  expect(sharePercent(1, 1000)).toBe("<1 %");
  expect(sharePercent(0, 0)).toBe("0 %");
  expect(dayKeyFromDateLabel("27.09.2026")).toBe("2026-09-27");
  expect(dayKeyFromDateLabel("вчера")).toBeNull();
  const days = fillPeriodDays("2026-09-29", "2026-10-02", new Map([["2026-10-01", { revenue: 1200, orders: 3 }]]));
  expect(days.map((day) => day.dayKey)).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  expect(days.map((day) => day.revenue)).toEqual([0, 0, 1200, 0]);
  // По умолчанию — 7 дней, включая сегодня, через границу месяца.
  expect(showcaseDefaultFromKey("2026-10-03")).toBe("2026-09-27");
});
