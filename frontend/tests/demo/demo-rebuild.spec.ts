import { expect, test } from "@playwright/test";

import { prisma } from "../../src/server/db/prisma";
import { withDemoLease } from "../../src/server/demo/lock";
import { demoLogin, waitForDemoWorld } from "./support";

/**
 * Пересборка мира атомарна и одна за раз: пока мир
 * пересобирается, посетитель видит прежний, а не полупустой; вторая
 * пересборка при занятой аренде в базе не запускается.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  await waitForDemoWorld(request);
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("сброс: мир ни на секунду не пустеет, заказы видны всё время пересборки", async ({ page }) => {
  test.setTimeout(180_000);
  await demoLogin(page, "owner");
  const before = (await (await page.request.get("/api/orders")).json()) as { pagination: { totalCount: number } };
  expect(before.pagination.totalCount).toBeGreaterThan(5);

  const seen: number[] = [];
  let resetting = true;
  const poll = (async () => {
    while (resetting) {
      const response = await page.request.get("/api/orders");
      if (response.ok()) seen.push(((await response.json()) as { pagination: { totalCount: number } }).pagination.totalCount);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  })();
  const reset = await page.request.post("/api/demo/reset", { data: {}, timeout: 150_000 });
  resetting = false;
  await poll;

  expect(reset.status()).toBe(200);
  expect((await reset.json()).mode).toBe("restored");
  expect(seen.length, "во время сброса были ответы").toBeGreaterThan(2);
  expect(Math.min(...seen), "ни одного пустого ответа").toBeGreaterThan(5);
});

test("одна пересборка за раз: пока аренду в базе держит другой, сброс не идёт", async ({ page }) => {
  test.setTimeout(180_000);
  await demoLogin(page, "owner");
  const held = await withDemoLease("world", async () => {
    const reset = await page.request.post("/api/demo/reset", { data: {}, timeout: 60_000 });
    expect(reset.status()).toBe(200);
    return (await reset.json()).mode as string;
  });
  expect(held.ran).toBe(true);
  expect(held.ran && held.value, "при занятой аренде сброс не запускается").toBe("building");

  const after = await page.request.post("/api/demo/reset", { data: {}, timeout: 150_000 });
  expect((await after.json()).mode, "аренда свободна — сброс идёт").toBe("restored");
});

test("после пересборки открытая вкладка мягко уходит на сводку с «Данные обновлены»", async ({ page, context }) => {
  test.setTimeout(180_000);
  await demoLogin(page, "owner");
  await page.goto("/orders/list");
  await expect(page.getByRole("heading", { name: "Заказы" })).toBeVisible({ timeout: 30_000 });
  // Плашка запомнила метку мира первым опросом статуса.
  await page.waitForLoadState("networkidle");

  // Мир пересобирают не из этой вкладки (как утренняя, тихая или чужая).
  const other = await context.newPage();
  const reset = await other.request.post("/api/demo/reset", { data: {}, timeout: 150_000 });
  expect((await reset.json()).mode).toBe("restored");
  await other.close();

  // Посетитель возвращается на вкладку — она не падает на исчезнувших данных.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForURL(/\/summary$/, { timeout: 30_000 });
  await expect(page.getByText("Данные обновлены")).toBeVisible();
});

