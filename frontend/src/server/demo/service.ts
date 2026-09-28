import { SHOWCASE_OPERATIONAL_TIME_ZONE } from "@/shared/operational-time";

import { lastVisitorActivityAt } from "./activity";
import { demoClockOffsetMs, installDemoClock, realNowMs, setDemoClockOffset } from "./clock";
import { installDemoDbClock, writeDemoDbClockOffset } from "./db-clock";
import { currentWorkdayClockOffset, demoClockNearClosing } from "./workday-clock";
import { withDemoLease } from "./lock";
import { isDemoMode } from "./mode";
import {
  advanceDemoToday,
  buildDemoWorld,
  describeDemoWorld,
  DemoWorldBusyError,
  readDemoState,
  readDemoWorldMeta,
  restoreDemoSnapshot,
  type DemoWorldMeta,
} from "./world";

/**
 * Демо-режим витрины (`SHOWCASE_DEMO=1`): один на процесс сервер-оркестратор
 * сборки, сброса и «живого» дня. Посетитель в любое время суток видит рабочий
 * день точек: до текущей минуты всё сделано, сейчас что-то в работе, дальше —
 * запись.
 *
 * - часы демо-мира (`workday-clock.ts`): днём (12:00–19:00 по времени
 *   точек) настоящие, иначе мир собирается «на 14:00» той же даты и часы идут
 *   дальше; сдвиг выбирается при каждой пересборке — сервер, браузер и метки
 *   базы идут по одним часам;
 * - при старте сервера: мира нет, он от другой схемы базы или не на сегодня —
 *   сборка сразу;
 * - каждый день в 08:00 по времени точек (06:00 по Москве) — полная сборка;
 * - каждые три минуты — план дня доводится до текущей минуты;
 * - раз в минуту проверка: мир старше часа и 20 минут тишины — тихая
 *   пересборка из снимка; часы мира ушли к вечеру точек, мир не на тот день
 *   или ему шесть часов — пересборка «по сроку»: ждёт 5 минут тишины, но не
 *   дольше 30;
 * - «Начать заново» (сброс) — та же пересборка, сразу.
 *
 * Любая пересборка атомарна и одна за раз (`world.ts`, аренда в базе).
 * Расписание и тишина посетителей — по настоящим часам. Состояние лежит на
 * `globalThis`: в dev-сервере модуль может загрузиться дважды (сервер и
 * маршруты), а сборка должна быть одна.
 */

export { isDemoMode };

/** 08:00 по времени точек (UTC+5) — это 06:00 по Москве. */
const DAILY_REBUILD_HOUR = 8;
const TICK_EVERY = 3 * 60_000;
/** Проверка пересборки — раз в минуту (дёшево: состояние мира в памяти и одна строка базы). */
const QUIET_CHECK_EVERY = 60_000;
const QUIET_AFTER_REBUILD = 60 * 60_000;
const QUIET_AFTER_VISITOR = 20 * 60_000;
/**
 * Пересборка «по сроку»: часы демо-мира ушли к вечеру точек или мир
 * старше шести часов. Ждёт 5 минут тишины посетителей, но не дольше 30 минут.
 */
const DUE_AFTER_QUIET = 5 * 60_000;
const DUE_AT_MOST = 30 * 60_000;
const WORLD_MAX_AGE = 6 * 60 * 60_000;

type DemoRuntime = {
  building: Promise<DemoWorldMeta | null> | null;
  /**
   * Сборку видно посетителю (плашка «Готовим данные», вход ждёт): её запустил
   * сброс посетителя или мира ещё нет. Ежедневная и тихая пересборки идут
   * незаметно — посетитель работает со старым миром до подмены.
   */
  buildingVisible: boolean;
  restoring: Promise<"restored" | "busy"> | null;
  ticking: Promise<unknown> | null;
  progress: number;
  label: string;
  lastError: string | null;
  lastResetAt: string | null;
  schedulerStarted: boolean;
  /** С какого момента (настоящее время) пересборка «по сроку» ждёт тишины. */
  dueSince?: number | null;
};

const KEY = "__showcaseDemoRuntime__";

function runtime(): DemoRuntime {
  const holder = globalThis as unknown as Record<string, DemoRuntime | undefined>;
  holder[KEY] ??= {
    building: null,
    buildingVisible: false,
    restoring: null,
    ticking: null,
    progress: 0,
    label: "",
    lastError: null,
    lastResetAt: null,
    schedulerStarted: false,
  };
  return holder[KEY]!;
}

function operationalHour(now: Date) {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: SHOWCASE_OPERATIONAL_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(now),
  );
}

function startBuild(reason: string, visible = false) {
  const state = runtime();
  if (state.building) {
    if (visible) state.buildingVisible = true;
    return state.building;
  }
  state.buildingVisible = visible;
  state.progress = 0;
  state.label = "Готовим данные";
  state.lastError = null;
  const started = realNowMs();
  state.building = buildDemoWorld({
    clockOffsetMs: currentWorkdayClockOffset(started),
    onProgress: (fraction, label) => {
      state.progress = fraction;
      state.label = label;
    },
  })
    .then((meta) => {
      state.lastResetAt = new Date(realNowMs()).toISOString();
      state.dueSince = null;
      console.log(`[demo] мир собран (${reason}) за ${Math.round((realNowMs() - started) / 1000)} с, часы мира ${formatOffset(meta.clockOffsetMs ?? 0)}`, JSON.stringify(meta.stats));
      return meta;
    })
    .catch((error: unknown) => {
      if (error instanceof DemoWorldBusyError) {
        console.log("[demo] сборка пропущена: мир уже пересобирается");
        return null;
      }
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error("[demo] сборка не удалась", error);
      return null;
    })
    .finally(() => {
      state.building = null;
      state.buildingVisible = false;
    });
  return state.building;
}

/**
 * Пересборка из утреннего снимка: сброс и тихая пересборка. `busy` — мир
 * сейчас пересобирает другой процесс (аренда в базе занята).
 */
function startRestore(reason: string, clockOffsetMs: number): Promise<"restored" | "busy"> {
  const state = runtime();
  if (state.restoring) return state.restoring;
  const started = realNowMs();
  state.restoring = (async () => {
    if (state.ticking) await state.ticking.catch(() => undefined);
    try {
      const result = await restoreDemoSnapshot(clockOffsetMs);
      state.dueSince = null;
      console.log(`[demo] мир пересобран из снимка (${reason}) за ${realNowMs() - started} мс, шагов дня: ${result.advanced}, часы мира ${formatOffset(clockOffsetMs)}`);
      return "restored" as const;
    } catch (error) {
      if (error instanceof DemoWorldBusyError) {
        console.log(`[demo] пересборка из снимка (${reason}) пропущена: мир уже пересобирается`);
        return "busy" as const;
      }
      console.error(`[demo] пересборка из снимка (${reason}) не удалась`, error);
      throw error;
    }
  })().finally(() => {
    state.restoring = null;
  });
  return state.restoring;
}

export async function tickDemoWorld() {
  const state = runtime();
  if (state.building || state.restoring) return { advanced: 0 };
  if (state.ticking) return state.ticking;
  // Ход дня — под той же арендой в базе, что и пересборка: два сервера на
  // одной базе не проведут один шаг плана дважды и не пойдут поперёк сборки.
  state.ticking = withDemoLease("world", () => advanceDemoToday(new Date()), 60_000)
    .then((result) => (result.ran ? result.value : { advanced: 0 }))
    .catch((error: unknown) => {
      console.error("[demo] ход дня не удался", error);
      return { advanced: 0 };
    })
    .finally(() => {
      state.ticking = null;
    });
  return state.ticking;
}

export type DemoResetResult = { mode: "restored" | "building"; durationMs: number };

/** «Сбросить демо»: утренний снимок и день до текущей минуты; мира нет на сегодня — сборка в фоне. */
export async function resetDemoWorld(): Promise<DemoResetResult> {
  const started = realNowMs();
  const state = runtime();
  if (state.building) return { mode: "building", durationMs: 0 };
  const plan = await planRebuild();
  if (!plan.restorable) {
    void startBuild("сброс посетителем, мир не на сегодня", true);
    return { mode: "building", durationMs: 0 };
  }
  let outcome: "restored" | "busy";
  try {
    outcome = await startRestore("сброс посетителем", plan.clockOffsetMs);
  } catch {
    return { mode: "building", durationMs: realNowMs() - started };
  }
  if (outcome === "busy") return { mode: "building", durationMs: realNowMs() - started };
  state.lastResetAt = new Date(realNowMs()).toISOString();
  return { mode: "restored", durationMs: realNowMs() - started };
}

/**
 * Какой будет следующая пересборка: сдвиг часов демо-мира на сейчас и можно
 * ли обойтись утренним снимком (тот же день мира и та же схема базы).
 */
async function planRebuild() {
  const real = realNowMs();
  const clockOffsetMs = currentWorkdayClockOffset(real);
  const world = await describeDemoWorld(new Date(real + clockOffsetMs));
  return { clockOffsetMs, world, restorable: Boolean(world.meta && world.sameDay && world.sameSchema) };
}

function formatOffset(offsetMs: number) {
  if (!offsetMs) return "настоящие";
  const minutes = Math.round(offsetMs / 60_000);
  const sign = minutes > 0 ? "+" : "−";
  return `${sign}${Math.floor(Math.abs(minutes) / 60)} ч ${Math.abs(minutes) % 60} мин`;
}

export async function getDemoStatus() {
  const state = runtime();
  const meta = await readDemoWorldMeta().catch(() => null);
  // Метка последней пересборки мира (сборка или снимок): открытая вкладка
  // сверяет её и после пересборки мягко уходит на стартовый экран.
  const rebuiltAt = meta ? ((await readDemoState<string>("last-rebuild-at").catch(() => null)) ?? meta.builtAt) : null;
  return {
    rebuiltAt,
    // Незаметная пересборка при живом мире — не «сборка» для посетителя.
    building: Boolean(state.building) && (state.buildingVisible || !meta),
    progress: state.progress,
    label: state.label,
    lastError: state.lastError,
    lastResetAt: state.lastResetAt,
    world: meta ? { dayKey: meta.dayKey, builtAt: meta.builtAt } : null,
  };
}

/**
 * Мир на сегодня: собрать, если его нет, он от другой схемы или от другого дня
 * по часам демо-мира (мир всегда показывает рабочий день, ждать 08:00
 * не нужно).
 */
async function ensureTodayWorld(atStartup: boolean) {
  const now = new Date();
  const world = await describeDemoWorld(now);
  if (!world.meta || !world.sameSchema) {
    await startBuild(world.meta ? "новая схема базы" : "мира нет", !world.meta);
    return false;
  }
  if (world.sameDay) return true;
  await startBuild(atStartup ? "запуск сервера, мир не сегодняшний" : "мир не на сегодня");
  return false;
}

/**
 * Тихая пересборка и пересборка «по сроку» (раз в минуту, по настоящему
 * времени): мир старше часа и 20 минут тишины — тихо из снимка; часы мира ушли
 * к вечеру точек или миру шесть часов — ждём 5 минут тишины, но не дольше 30.
 */
async function quietRebuildIfIdle() {
  const state = runtime();
  if (state.building || state.restoring) return;
  const real = realNowMs();
  const current = await describeDemoWorld(new Date());
  if (!current.meta || !current.sameSchema) return;
  const age = current.lastRebuildAt ? real - current.lastRebuildAt : Number.POSITIVE_INFINITY;
  const lastActivity = lastVisitorActivityAt();
  const quietFor = lastActivity ? real - lastActivity : Number.POSITIVE_INFINITY;
  const due = !current.sameDay || demoClockNearClosing(Date.now()) || age >= WORLD_MAX_AGE;
  let reason: string | null = null;
  if (due) {
    state.dueSince ??= real;
    if (quietFor >= DUE_AFTER_QUIET) reason = "по сроку, посетителей нет 5 минут";
    else if (real - state.dueSince >= DUE_AT_MOST) reason = "по сроку, ждали тишины 30 минут";
  } else {
    state.dueSince = null;
    if (age >= QUIET_AFTER_REBUILD && quietFor >= QUIET_AFTER_VISITOR) reason = "тихая пересборка";
  }
  if (!reason) return;
  const plan = await planRebuild();
  if (plan.restorable) {
    await startRestore(reason, plan.clockOffsetMs).catch(() => undefined);
  } else {
    await startBuild(reason);
  }
}

/** Мс до ближайших 08:00 по времени точек — по настоящим часам. */
function msUntilDailyRebuild(now = new Date(realNowMs())) {
  const hourMs = 60 * 60_000;
  const localHour = operationalHour(now);
  const minutes = now.getUTCMinutes();
  const seconds = now.getUTCSeconds();
  const sinceHourStart = (minutes * 60 + seconds) * 1000 + now.getUTCMilliseconds();
  const hoursAhead = (DAILY_REBUILD_HOUR - localHour + 24) % 24 || 24;
  return hoursAhead * hourMs - sinceHourStart + 5_000;
}

/** Планировщик: при старте, ход дня, тихая пересборка, ежедневная пересборка. */
export function startDemoScheduler() {
  const state = runtime();
  if (state.schedulerStarted || !isDemoMode()) return;
  state.schedulerStarted = true;

  const safely = (task: () => Promise<unknown>) => () => void task().catch((error) => console.error("[demo] планировщик", error));

  // Часы демо-мира: подмена `Date` ставится сразу, сдвиг — из собранного мира.
  installDemoClock();
  void (async () => {
    const meta = await readDemoWorldMeta().catch(() => null);
    setDemoClockOffset(meta?.clockOffsetMs ?? 0);
    await installDemoDbClock();
    await writeDemoDbClockOffset(demoClockOffsetMs());
  })().catch((error) => console.error("[demo] часы демо-мира", error));

  const tick = safely(async () => {
    if (state.building || state.restoring) return;
    if (await ensureTodayWorld(false)) await tickDemoWorld();
  });

  // Каждый день в 08:00 по времени точек (06:00 по Москве) — полная сборка
  // заново, даже если мир уже сегодняшний: свежая история и снимок.
  const scheduleDaily = () => {
    setTimeout(() => {
      safely(async () => {
        await startBuild("ежедневная пересборка");
      })();
      scheduleDaily();
    }, msUntilDailyRebuild()).unref?.();
  };

  setTimeout(
    safely(async () => {
      if (await ensureTodayWorld(true)) await tickDemoWorld();
    }),
    3_000,
  ).unref?.();
  setInterval(tick, TICK_EVERY).unref?.();
  setInterval(safely(quietRebuildIfIdle), QUIET_CHECK_EVERY).unref?.();
  scheduleDaily();
}
