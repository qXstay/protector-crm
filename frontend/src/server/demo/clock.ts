import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Часы генератора демо-данных.
 *
 * Генератор витрины пишет историю за несколько месяцев теми же функциями
 * репозиториев, что и экраны: смена открывается `openShiftForBranch`, заказ
 * проводится `updateOrderForBranch`, хранение принимается
 * `createStorageRecordForBranch`. Эти функции берут время из `new Date()`.
 * Чтобы смена прошлого вторника открылась во вторник, а не сейчас, генератор
 * выполняет каждую операцию внутри `runAtDemoTime(момент, …)`: в этом
 * асинхронном контексте `new Date()` и `Date.now()` отдают смоделированное
 * время, которое идёт вперёд вместе с настоящим (задержки и повторы
 * транзакций продолжают работать). Все остальные запросы сервера идут вне
 * контекста и видят настоящее время — подмена их не касается.
 */

type ClockFrame = { simulatedStart: number; realStart: number };

const GLOBAL_KEY = "__showcaseDemoClock__";

type ClockState = {
  storage: AsyncLocalStorage<ClockFrame>;
  realDate: DateConstructor;
  installed: boolean;
  /**
   * Часы демо-мира: сдвиг «сейчас» всего сервера относительно
   * настоящего времени. Ночью у точек витрина держит рабочий день — часы
   * стоят на рабочем часе (`workday-clock.ts`); днём сдвиг 0. Внутри
   * `runAtDemoTime` действует своё смоделированное время, сдвиг не нужен.
   */
  offsetMs?: number;
};

function state(): ClockState {
  const holder = globalThis as unknown as Record<string, ClockState | undefined>;
  if (!holder[GLOBAL_KEY]) {
    holder[GLOBAL_KEY] = {
      storage: new AsyncLocalStorage<ClockFrame>(),
      realDate: Date,
      installed: false,
      offsetMs: 0,
    };
  }
  return holder[GLOBAL_KEY]!;
}

function simulatedNow(frame: ClockFrame, realDate: DateConstructor) {
  return frame.simulatedStart + (realDate.now() - frame.realStart);
}

function install() {
  const current = state();
  if (current.installed) {
    return;
  }

  const RealDate = current.realDate;
  const storage = current.storage;

  const shifted = () => RealDate.now() + (current.offsetMs ?? 0);

  const DemoDate = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) {
        const frame = storage.getStore();
        if (frame) {
          return Reflect.construct(target, [simulatedNow(frame, RealDate)], newTarget);
        }
        if (current.offsetMs) {
          return Reflect.construct(target, [shifted()], newTarget);
        }
      }
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, thisArg, args) {
      const frame = storage.getStore();
      if (frame) {
        return new RealDate(simulatedNow(frame, RealDate)).toString();
      }
      if (current.offsetMs) {
        return new RealDate(shifted()).toString();
      }
      return Reflect.apply(target, thisArg, args);
    },
    get(target, property, receiver) {
      if (property === "now") {
        return () => {
          const frame = storage.getStore();
          return frame ? simulatedNow(frame, RealDate) : shifted();
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  (globalThis as { Date: DateConstructor }).Date = DemoDate;
  current.installed = true;
}

/** Выполнить `task` так, будто сейчас `at`. */
export function runAtDemoTime<T>(at: Date | number, task: () => Promise<T>): Promise<T> {
  install();
  const current = state();
  const simulatedStart = typeof at === "number" ? at : at.getTime();
  return current.storage.run({ simulatedStart, realStart: current.realDate.now() }, task);
}

/** Настоящее время, даже внутри `runAtDemoTime` и при сдвиге часов демо-мира. */
export function realNow(): Date {
  return new (state().realDate)();
}

/** Настоящее время в мс — для расписания пересборок и активности посетителей. */
export function realNowMs(): number {
  return state().realDate.now();
}

/** Поставить подмену `Date` заранее (при старте сервера в демо-режиме). */
export function installDemoClock() {
  install();
}

/** Сдвиг часов демо-мира: всё «сейчас» сервера = настоящее + `offsetMs`. */
export function setDemoClockOffset(offsetMs: number) {
  install();
  state().offsetMs = Math.round(offsetMs);
}

export function demoClockOffsetMs(): number {
  return state().offsetMs ?? 0;
}
