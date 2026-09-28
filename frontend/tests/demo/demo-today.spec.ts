import { expect, test } from "@playwright/test";

import { DemoHistoryGenerator } from "../../src/server/demo/generator";
import { worldAnchor } from "../../src/server/demo/world";

/**
 * «Сегодня» витрины: мир детерминирован по дате, а в любой момент рабочего
 * дня на каждой точке в работе одна-две машины. План дня
 * строится без базы — это чистая часть генератора.
 */
const MINUTE = 60_000;

function planAt(iso: string) {
  return new DemoHistoryGenerator({ now: worldAnchor(new Date(iso)), historyDays: 0, futureDays: 0 }).planToday();
}

test("пересборка в течение дня даёт тот же день, другой день — другой", () => {
  const morning = planAt("2026-09-26T08:05:00+05:00");
  const evening = planAt("2026-09-26T19:40:00+05:00");
  expect(JSON.stringify(evening)).toBe(JSON.stringify(morning));
  expect(JSON.stringify(planAt("2026-09-27T09:00:00+05:00"))).not.toBe(JSON.stringify(morning));
});

test("весь рабочий день на каждой точке в работе одна-две машины, последняя уезжает до закрытия", () => {
  for (const day of ["2026-09-26", "2026-09-28", "2026-10-04", "2026-11-15"]) {
    const plan = planAt(`${day}T12:00:00+05:00`);
    expect(plan.shifts).toHaveLength(3);
    for (const shift of plan.shifts) {
      const orders = plan.orders.filter((order) => order.branchId === shift.branchId);
      expect(orders.length, `${day} ${shift.branchId}: заказов за день`).toBeGreaterThan(10);
      for (let at = shift.openAt + 25 * MINUTE; at <= shift.closeAt - 30 * MINUTE; at += 5 * MINUTE) {
        const inWork = orders.filter((order) => order.startAt <= at && at < order.finishAt).length;
        const label = `${day} ${shift.branchId} ${new Date(at).toISOString()}`;
        expect(inWork, `${label}: в работе`).toBeGreaterThanOrEqual(1);
        expect(inWork, `${label}: в работе`).toBeLessThanOrEqual(2);
      }
      for (const order of orders) {
        expect(order.finishAt, `${order.id} уезжает до закрытия смены`).toBeLessThanOrEqual(shift.closeAt - 10 * MINUTE);
        expect(order.payment, `${order.id}: сегодня всё оплачивается`).not.toBeNull();
      }
    }
  }
});
