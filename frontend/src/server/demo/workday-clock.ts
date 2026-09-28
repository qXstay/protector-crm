/**
 * Часы демо-мира: витрина в любое время суток показывает рабочий
 * день точек.
 *
 * Днём (12:00–19:00 по времени точек) часы демо-мира — настоящие. В остальное
 * время мир собирается «на 14:00» сегодняшней даты и дальше часы идут как
 * обычно: сдвиг выбирается при каждой пересборке и держится до следующей,
 * поэтому мир всегда между 14:00 и вечером — смены открыты, в работе машины,
 * есть оплаченные заказы и ближайшие записи. Часовой пояс UTC+5 и логика смен
 * не меняются: сдвигается только «сейчас».
 *
 * Для съёмки материалов (не для работы витрины) часы можно поставить на
 * заданное время: `SHOWCASE_SHOT_CLOCK=14:00`. В боевом запуске переменной
 * нет — это проверяет тест.
 */

/** Время точек — UTC+5 (как в логике смен). */
const POINTS_TZ_OFFSET_MS = 5 * 3_600_000;

/** Окно, в котором часы демо-мира настоящие, и час, на который встаёт мир вне его. */
export const WORKDAY_CLOCK = { realFrom: 12 * 60, realTo: 19 * 60, anchor: 14 * 60 } as const;

/** Часы для съёмки: «ЧЧ:ММ» из окружения, иначе null. */
export function shotClockSetting(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.SHOWCASE_SHOT_CLOCK?.trim();
  return value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

/** Часы демо-мира можно выключить (`SHOWCASE_WORKDAY_CLOCK=0`) — тогда мир живёт по настоящему времени. */
export function workdayClockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SHOWCASE_WORKDAY_CLOCK?.trim() !== "0";
}

/**
 * Сдвиг «сейчас» демо-мира для настоящего момента `realMs`, в целых минутах.
 * 0 — днём; иначе столько, чтобы по времени точек было 14:00 той же даты
 * (или время съёмки `shotClock`).
 */
export function workdayClockOffset(realMs: number, options: { shotClock?: string | null; enabled?: boolean } = {}): number {
  const shotClock = options.shotClock ?? null;
  if (!shotClock && options.enabled === false) return 0;
  const wall = new Date(realMs + POINTS_TZ_OFFSET_MS);
  const minutes = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  let target: number;
  if (shotClock) {
    const [hours, mins] = shotClock.split(":").map(Number);
    target = hours * 60 + mins;
  } else if (minutes >= WORKDAY_CLOCK.realFrom && minutes < WORKDAY_CLOCK.realTo) {
    return 0;
  } else {
    target = WORKDAY_CLOCK.anchor;
  }
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) - POINTS_TZ_OFFSET_MS;
  const targetMs = midnight + target * 60_000;
  return Math.round((targetMs - realMs) / 60_000) * 60_000;
}

/** Сдвиг по текущим настройкам окружения. */
export function currentWorkdayClockOffset(realMs: number): number {
  return workdayClockOffset(realMs, { shotClock: shotClockSetting(), enabled: workdayClockEnabled() });
}

/**
 * Пора ли пересобрать мир, потому что его часы ушли к вечеру: мир «на 14:00»
 * идёт вперёд, и к 20:00 по его часам точки закрываются. Днём со сдвигом 0
 * это тоже вечер у точек — пора переходить на часы рабочего дня.
 */
export function demoClockNearClosing(demoNowMs: number): boolean {
  const wall = new Date(demoNowMs + POINTS_TZ_OFFSET_MS);
  const minutes = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  return minutes >= 20 * 60 || minutes < 9 * 60;
}
