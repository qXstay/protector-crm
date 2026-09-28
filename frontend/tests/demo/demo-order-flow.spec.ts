import { expect, test, type Page } from "@playwright/test";

import { waitForDemoWorld } from "./support";

/**
 * Витрина: заказ за минуту. «Новый заказ» сразу открывает сам
 * заказ — без выбора клиента, режима и смены перед ним. Клиент — необязательная
 * строка в заказе: одно поле ищет с 2 букв или 3 цифр по фамилии, телефону и
 * госномеру, выбирать можно мышью и клавиатурой, в пустом поле — записи на
 * сегодня. Дальше обычный путь системы: тип и диаметр, услуги, оплата, чек.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  await waitForDemoWorld(request);
});

type SearchVehicle = { id: string; brand: string; model: string; plateNumber: string; notRegisteredInRf?: boolean };
type SearchClient = { id: string; name: string; phone: string; vehicles: SearchVehicle[] };

async function openNewOrder(page: Page) {
  await page.request.post("/api/auth/demo", { data: { role: "owner" } });
  await page.goto("/summary");
  await page.locator("#demo-main").getByRole("link", { name: "Новый заказ" }).click();
  await page.waitForURL(/\/orders\?id=order-/, { timeout: 30_000 });
  const search = page.locator("[data-order-client-inline]").getByRole("combobox");
  await expect(search).toBeVisible({ timeout: 30_000 });
  return search;
}

/** Клиент мира с одной машиной с русским номером и телефоном — для поиска. */
async function pickClient(page: Page, query: string) {
  const response = await page.request.get(`/api/clients?view=search&q=${encodeURIComponent(query)}&limit=20`);
  expect(response.ok()).toBe(true);
  const { clients } = (await response.json()) as { clients: SearchClient[] };
  const client = clients.find(
    (item) =>
      item.vehicles.length === 1 &&
      !item.vehicles[0].notRegisteredInRf &&
      /^[А-Я]\d{3}[А-Я]{2}\d{2,3}$/.test(item.vehicles[0].plateNumber.replace(/\s/g, "")) &&
      item.phone.replace(/\D/g, "").length === 11 &&
      /^[А-ЯЁ][а-яё]+ [А-ЯЁ]/.test(item.name),
  );
  expect(client, `клиент по запросу «${query}»`).toBeTruthy();
  return client!;
}

test("«Новый заказ» сразу открывает заказ, без выбора перед ним; повторный — тот же пустой черновик", async ({ page }) => {
  await openNewOrder(page);
  const main = page.locator("#demo-main");
  const firstUrl = page.url();

  // Сам заказ: тип и диаметр, «Принять оплату»; режимов карточки и смены перед ним нет.
  await expect(main.getByRole("group", { name: "Тип автомобиля" })).toBeVisible();
  await expect(main.getByRole("group", { name: "Диаметр" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Принять оплату" })).toBeVisible();
  await expect(main.locator("[data-order-client-inline]").getByRole("button", { name: "Новый клиент" })).toBeVisible();
  for (const label of ["Найти в базе", "Анонимно", "Продолжить без клиента", "Открыть смену"]) {
    await expect(main.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }
  await expect(main.getByText("Смена не открыта")).toHaveCount(0);

  // Нетронутый черновик не плодится: «Новый заказ» ещё раз открывает его же.
  await page.locator('nav[aria-label="Разделы"]').getByRole("link", { name: "Сводка" }).click();
  await page.waitForURL(/\/summary$/);
  await page.locator("#demo-main").getByRole("link", { name: "Новый заказ" }).click();
  await page.waitForURL(/\/orders\?id=order-/, { timeout: 30_000 });
  expect(page.url()).toBe(firstUrl);
});

test("поиск клиента в заказе: фамилия с двух букв (сначала сама фамилия), телефон с трёх цифр, госномер; выбор клавиатурой", async ({ page }) => {
  const search = await openNewOrder(page);
  const client = await pickClient(page, "ов");
  const surname = client.name.split(" ")[0];
  const listbox = page.locator("[data-order-client-inline]").getByRole("listbox");
  const options = listbox.getByRole("option");

  // Одна буква — подсказка, а не пустота.
  await search.click();
  await search.fill(surname.slice(0, 1));
  await expect(page.locator("[data-order-client-inline]")).toContainText("Ещё букву");

  // Две буквы — уже совпадения, и первые — с начала ФИО.
  await search.fill(surname.slice(0, 2));
  await expect(options.first()).toBeVisible({ timeout: 15_000 });
  await expect(options.first()).toContainText(new RegExp(`^${surname.slice(0, 2)}`, "i"));

  // Вся фамилия — среди совпадений сам клиент, выше тех, у кого она только в отчестве.
  await search.fill(surname);
  await expect(options.filter({ hasText: client.name })).toHaveCount(1, { timeout: 15_000 });
  const names = (await options.allInnerTexts()).map((text) => text.split("\n")[0].trim());
  const firstPatronymic = names.findIndex((name) => !name.toLowerCase().startsWith(surname.toLowerCase().slice(0, -1)));
  const lastSurname = names.map((name) => name.toLowerCase().startsWith(surname.toLowerCase().slice(0, -1))).lastIndexOf(true);
  if (firstPatronymic >= 0) expect(lastSurname).toBeLessThan(firstPatronymic);

  // Три цифры телефона и госномер находят того же клиента.
  const phoneDigits = client.phone.replace(/\D/g, "");
  await search.fill(phoneDigits.slice(-7, -4));
  await expect(options.filter({ hasText: client.phone }).first()).toBeVisible({ timeout: 15_000 });
  const plate = client.vehicles[0].plateNumber.replace(/\s/g, "");
  await search.fill(plate.toLowerCase());
  await expect(options.first()).toContainText(client.name, { timeout: 15_000 });

  // Клавиатура: стрелка вниз и Enter — клиент и машина в заказе.
  await search.press("ArrowDown");
  await search.press("Enter");
  const header = page.locator("[data-order-editor-header]");
  await expect(header).toContainText(client.name, { timeout: 20_000 });
  await expect(header).toContainText(client.vehicles[0].brand);
});

test("выбор мышью и записи на сегодня в пустом поле", async ({ page }) => {
  const search = await openNewOrder(page);
  const inline = page.locator("[data-order-client-inline]");
  const options = inline.getByRole("listbox").getByRole("option");

  // Пустое поле по нажатию показывает записи на сегодня (если они ещё есть) и «Новый клиент».
  await search.click();
  await expect(inline.getByRole("button", { name: "Новый клиент" }).last()).toBeVisible();
  const bookings = await options.count();
  if (bookings > 0) await expect(inline.getByText("Сегодня по записи")).toBeVisible();

  const client = await pickClient(page, "ва");
  await search.fill(client.name.split(" ").slice(0, 2).join(" "));
  const option = options.filter({ hasText: client.name }).first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await expect(page.locator("[data-order-editor-header]")).toContainText(client.name, { timeout: 20_000 });
});

test("путь до чека: тип, диаметр, услуги, «Принять оплату» — чек выезжает сам", async ({ page }) => {
  await openNewOrder(page);
  const main = page.locator("#demo-main");
  await main.getByRole("group", { name: "Тип автомобиля" }).getByRole("button").first().click();
  await main.getByRole("group", { name: "Диаметр" }).getByRole("button", { name: /R16/ }).click();
  const firstService = main.locator("[data-catalog-row]").first();
  await expect(firstService).toBeVisible({ timeout: 20_000 });
  await firstService.getByRole("button", { name: "4", exact: true }).click();

  await page.getByRole("button", { name: "Принять оплату" }).click();
  const payment = page.getByRole("dialog", { name: "Приём оплаты" });
  await expect(payment).toBeVisible({ timeout: 20_000 });
  await payment.getByRole("radio", { name: "Способ оплаты: Безнал (эквайринг)" }).click();
  const accounts = payment.getByRole("radiogroup", { name: "Счёт зачисления" });
  if ((await accounts.count()) > 0 && (await accounts.getByRole("radio", { checked: true }).count()) === 0) {
    await accounts.getByRole("radio").first().click();
  }
  await payment.getByRole("button", { name: /^Принять/ }).click();
  await page.waitForURL(/\/orders\/view\//, { timeout: 30_000 });
  await expect(page.getByRole("dialog", { name: /^Чек по заказу/ })).toBeVisible({ timeout: 30_000 });
});

test("сводка: заголовок без строки даты над ним, лента записей не длиннее пяти, «Оформить» открывает заказ по записи", async ({ page }) => {
  await page.request.post("/api/auth/demo", { data: { role: "owner" } });
  await page.goto("/summary");
  const main = page.locator("#demo-main");
  const heading = main.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Сводка по сети", { timeout: 30_000 });
  // Над заголовком ничего нет: дата и время — строкой под ним, пояс — один раз.
  const headerBlock = heading.locator("xpath=..");
  await expect(headerBlock.locator(":scope > :first-child")).toHaveText("Сводка по сети");
  await expect(main.getByText("время точек, UTC+5")).toHaveCount(1);
  // «Требует внимания» — только дела, без списка пройденных проверок.
  await expect(main.getByRole("list", { name: "В порядке" })).toHaveCount(0);
  const networkCard = main.locator("section").filter({ has: page.getByRole("heading", { name: "Ближайшие записи" }) });
  expect(await networkCard.getByRole("listitem").count()).toBeLessThanOrEqual(5);

  // Администратор точки: лента — записи только его точки, у каждой «Оформить».
  await page.request.post("/api/auth/demo", { data: { role: "employee" } });
  await page.goto("/summary");
  const card = main.locator("section").filter({ has: page.getByRole("heading", { name: "Ближайшие записи" }) });
  await expect(card).toBeVisible({ timeout: 30_000 });
  const actions = card.getByRole("link", { name: "Оформить" });
  expect(await actions.count(), "у ближайших записей точки есть «Оформить»").toBeGreaterThan(0);
  // Строка с первым «Оформить»: внутренний локатор фильтра — относительно строки.
  const row = card.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Оформить" }) }).first();
  const action = row.getByRole("link", { name: "Оформить" });
  const clientName = (await row.locator("span.truncate").first().innerText()).trim();
  const href = (await action.getAttribute("href")) ?? "";
  await action.click();
  if (href.startsWith("/orders?clientId=")) {
    // Запись с карточкой клиента — заказ сразу с клиентом и машиной записи.
    await page.waitForURL(/\/orders\?id=order-/, { timeout: 30_000 });
    await expect(page.locator("[data-order-editor-header]")).toContainText(clientName, { timeout: 30_000 });
  } else {
    // Онлайн-запись без карточки — заказ и «Новый клиент» с её именем и телефоном.
    expect(href).toMatch(/^\/orders\/new\?booking=/);
    const dialog = page.getByRole("dialog", { name: "Новый клиент" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByLabel("ФИО")).toHaveValue(clientName);
  }
});
