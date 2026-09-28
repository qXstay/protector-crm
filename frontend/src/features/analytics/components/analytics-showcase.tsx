"use client";

import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";

import Link from "@/components/ui/app-link";
import { Card, Delta, Tile } from "@/features/summary/components/dashboard-parts";
import { RevenueChart } from "@/features/summary/components/revenue-chart";
import { countLabel, formatRub } from "@/shared/format";

/*
 * Витрина: Аналитика наглядно. Сверху 3–4 главных числа, дальше
 * графики вместо длинных таблиц (выручка по дням, по точкам, способы оплаты,
 * услуги, мастера), подробные таблицы системы — свёрнуты. Всё — из тех же
 * read-моделей, что и таблицы рабочей системы; новых показателей нет.
 * Цвета спокойные: шкалы графитом, оранжевым — только главное (текущая точка).
 */

/** Строка полоскового графика: подпись, сумма, шкала от самой крупной строки. */
export type ShowcaseBarRow = {
  key: string;
  label: string;
  /** Рубли (не копейки). */
  value: number;
  note?: string;
  /** Главное в списке (текущая точка) — оранжевым; остальные — графитом. */
  accent?: boolean;
  href?: string;
};

export function BarList({ rows, emptyText, footer }: { rows: ShowcaseBarRow[]; emptyText: string; footer?: ReactNode }) {
  if (rows.length === 0) {
    return <p className="m-0 py-6 text-center text-15 text-fg-secondary">{emptyText}</p>;
  }
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-3.5 p-0" data-showcase-bars="">
        {rows.map((row) => {
          const body = (
            <>
              <span className="flex items-baseline justify-between gap-3">
                <span className={clsx("min-w-0 truncate text-15 text-fg", row.accent && "font-medium")}>{row.label}</span>
                <span className="shrink-0 text-15 font-semibold tabular-nums text-fg">{formatRub(Math.round(row.value))}</span>
              </span>
              <span className="mt-1.5 flex items-center gap-2.5">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas-strong">
                  <span
                    className={clsx("block h-full rounded-full", row.accent ? "bg-accent-graphic" : "bg-chart-meter")}
                    style={{ width: `${Math.max(1.5, Math.round((row.value / max) * 1000) / 10)}%` }}
                  />
                </span>
                {row.note ? <span className="shrink-0 text-13 text-fg-secondary">{row.note}</span> : null}
              </span>
            </>
          );
          return (
            <li key={row.key}>
              {row.href ? (
                <Link href={row.href} className="-mx-2 block rounded-md px-2 py-0.5 transition-[background-color] motion-fast hover:bg-hover-row">
                  {body}
                </Link>
              ) : (
                <div className="block">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {footer ? <div className="pt-4 text-14">{footer}</div> : null}
    </>
  );
}

export { sharePercent } from "@/features/analytics/showcase-days";
import { sharePercent } from "@/features/analytics/showcase-days";

/**
 * Подробные таблицы системы — свёрнутыми под графиками. Свёрнутое не
 * рисуется, пока его не открыли: экран с графиками приходит быстрее, а
 * открытое так и остаётся нарисованным.
 */
export function Fold({ title, note, children, className }: { title: string; note?: string; children: ReactNode; className?: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className={clsx("group border-t border-line", className)}
      data-analytics-fold=""
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-4 text-16 font-semibold tracking-[-0.01em] text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-fg-secondary transition-transform motion-fast group-open:rotate-90" aria-hidden="true" />
        {title}
        {note ? <span className="text-14 font-normal text-fg-secondary">{note}</span> : null}
      </summary>
      <div className="pb-2">{opened ? children : null}</div>
    </details>
  );
}

export { dayKeyFromDateLabel, fillPeriodDays, type ShowcaseDay } from "@/features/analytics/showcase-days";
import type { ShowcaseDay } from "@/features/analytics/showcase-days";

/** Данные «Обзора» витрины, которых нет в экране рабочей системы. */
export type AnalyticsShowcaseExtras = {
  /** Прошлый период той же длины: выручка и заказы — для отметки изменения. */
  previous: { from: string; to: string; revenueCents: number; ordersCount: number };
  /** Выручка точек сети за тот же период (только доступные посетителю точки). */
  branches: Array<{ id: string; label: string; revenueCents: number; ordersCount: number; current: boolean }>;
  /** Оплаты по способам за период (модель «Денег»); `null` — не загрузились. */
  methods: Array<{ key: string; label: string; amountCents: number; count: number }> | null;
};

export function AnalyticsShowcaseTop({
  period,
  todayKey,
  revenueCents,
  ordersCount,
  accruedCents,
  hasAccruals,
  days,
  services,
  masters,
  extras,
}: {
  period: { from: string; to: string };
  todayKey: string;
  revenueCents: number;
  ordersCount: number;
  accruedCents: number;
  hasAccruals: boolean;
  days: ShowcaseDay[];
  services: Array<{ key: string; name: string; revenueCents: number; ordersCount: number }>;
  masters: Array<{ id: string; label: string; accruedCents: number; ordersCount: number }>;
  extras: AnalyticsShowcaseExtras;
}) {
  const revenue = revenueCents / 100;
  const averageCheck = ordersCount > 0 ? revenue / ordersCount : 0;
  const previousRevenue = extras.previous.revenueCents / 100;
  const previousAverage = extras.previous.ordersCount > 0 ? previousRevenue / extras.previous.ordersCount : 0;
  const previousTitle = `Прошлый период: с ${formatDayKey(extras.previous.from)} по ${formatDayKey(extras.previous.to)}`;
  const periodQuery = `from=${period.from}&to=${period.to}`;

  const branchRows: ShowcaseBarRow[] = extras.branches
    .slice()
    .sort((left, right) => right.revenueCents - left.revenueCents)
    .map((branch) => ({
      key: branch.id,
      label: branch.current ? `${branch.label}, текущая` : branch.label,
      value: branch.revenueCents / 100,
      note: countLabel(branch.ordersCount, ["заказ", "заказа", "заказов"]),
      accent: branch.current,
    }));

  const methodsTotal = (extras.methods ?? []).reduce((sum, row) => sum + row.amountCents, 0);
  const methodRows: ShowcaseBarRow[] = (extras.methods ?? [])
    .slice()
    .sort((left, right) => right.amountCents - left.amountCents)
    .map((row) => ({
      key: row.key,
      label: row.label,
      value: row.amountCents / 100,
      note: `${sharePercent(row.amountCents, methodsTotal)}, ${countLabel(row.count, ["оплата", "оплаты", "оплат"])}`,
    }));

  const TOP_SERVICES = 6;
  const sortedServices = services.slice().sort((left, right) => right.revenueCents - left.revenueCents);
  const restServices = sortedServices.slice(TOP_SERVICES);
  const serviceRows: ShowcaseBarRow[] = [
    ...sortedServices.slice(0, TOP_SERVICES).map((service) => ({
      key: service.key,
      label: service.name,
      value: service.revenueCents / 100,
      note: countLabel(service.ordersCount, ["заказ", "заказа", "заказов"]),
    })),
    ...(restServices.length > 0
      ? [
          {
            key: "rest",
            label: `Остальные ${countLabel(restServices.length, ["услуга", "услуги", "услуг"])}`,
            value: restServices.reduce((sum, service) => sum + service.revenueCents, 0) / 100,
          },
        ]
      : []),
  ];

  const TOP_MASTERS = 6;
  const sortedMasters = masters.slice().sort((left, right) => right.accruedCents - left.accruedCents);
  const masterRows: ShowcaseBarRow[] = sortedMasters.slice(0, TOP_MASTERS).map((master) => ({
    key: master.id,
    label: master.label,
    value: master.accruedCents / 100,
    note: countLabel(master.ordersCount, ["заказ", "заказа", "заказов"]),
    href: `/analytics/payroll?${periodQuery}&employee=${encodeURIComponent(master.id)}`,
  }));

  const showDays = days.length >= 3;
  const showBranches = branchRows.length > 1;

  return (
    <div className="flex flex-col gap-5 pb-6" data-analytics-showcase="">
      <section className="grid grid-cols-4 gap-4 max-xl:grid-cols-2 max-sm:gap-3">
        <Tile
          label="Выручка за период"
          value={revenue}
          format="rub"
          footer={<Delta current={revenue} previous={previousRevenue} suffix="к прошлому периоду" title={previousTitle} />}
        />
        <Tile
          label="Заказов"
          value={ordersCount}
          footer={<Delta current={ordersCount} previous={extras.previous.ordersCount} suffix="к прошлому периоду" title={previousTitle} />}
        />
        <Tile
          label="Средний чек"
          value={Math.round(averageCheck)}
          format="rub"
          footer={<Delta current={averageCheck} previous={previousAverage} suffix="к прошлому периоду" title={previousTitle} />}
        />
        <Tile
          label="Начислено мастерам"
          value={hasAccruals ? Math.round(accruedCents / 100) : 0}
          format="rub"
          footer={
            <span className="text-13 text-fg-secondary">
              {hasAccruals ? `${sharePercent(accruedCents, revenueCents)} выручки` : "Начислений за период нет"}
            </span>
          }
        />
      </section>

      {showDays || showBranches ? (
        <div className={clsx("grid gap-5", showDays && showBranches && "xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]")}>
          {showDays ? (
            <Card title="Выручка по дням" action={<span className="font-semibold tabular-nums text-fg">{formatRub(revenue)}</span>}>
              <RevenueChart days={days} dayOver={period.to !== todayKey} />
            </Card>
          ) : null}
          {showBranches ? (
            <Card title="По точкам">
              <BarList rows={branchRows} emptyText="За период выручки нет" />
            </Card>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        <Card title="Способы оплаты">
          {extras.methods === null ? (
            <p className="m-0 py-6 text-center text-15 text-fg-secondary">Оплаты за период не загрузились</p>
          ) : (
            <BarList rows={methodRows} emptyText="За период оплат нет" />
          )}
        </Card>
        <Card title="Услуги">
          <BarList rows={serviceRows} emptyText="За период оплаченных услуг нет" />
        </Card>
        <Card
          title="Мастера"
          action={
            <Link href={`/analytics/payroll?${periodQuery}`} className="touch-target font-medium text-accent hover:text-accent-hover">
              Ведомость →
            </Link>
          }
        >
          <BarList
            rows={masterRows}
            emptyText="Начислений за период нет"
            footer={
              sortedMasters.length > TOP_MASTERS ? (
                <span className="text-fg-secondary">и ещё {countLabel(sortedMasters.length - TOP_MASTERS, ["мастер", "мастера", "мастеров"])}</span>
              ) : undefined
            }
          />
        </Card>
      </div>
    </div>
  );
}

function formatDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split("-");
  return `${day}.${month}.${year}`;
}

/** Данные «Денег» витрины для верхнего ряда и графиков. */
export function MoneyShowcaseTop({
  period,
  todayKey,
  totalCents,
  paymentsCount,
  cashAvailableCents,
  expensesCents,
  days,
  methods,
  accounts,
}: {
  period: { from: string; to: string };
  todayKey: string;
  totalCents: number;
  paymentsCount: number;
  cashAvailableCents: number | null;
  expensesCents: number | null;
  days: ShowcaseDay[];
  methods: Array<{ key: string; label: string; amountCents: number; count: number }>;
  accounts: Array<{ key: string; label: string; amountCents: number; count: number }>;
}) {
  const total = totalCents / 100;
  const rows = (items: typeof methods): ShowcaseBarRow[] =>
    items
      .slice()
      .sort((left, right) => right.amountCents - left.amountCents)
      .map((row) => ({
        key: row.key,
        label: row.label,
        value: row.amountCents / 100,
        note: `${sharePercent(row.amountCents, totalCents)}, ${countLabel(row.count, ["оплата", "оплаты", "оплат"])}`,
      }));

  return (
    <div className="flex flex-col gap-5 pb-6" data-money-showcase="">
      <section className="grid grid-cols-4 gap-4 max-xl:grid-cols-2 max-sm:gap-3">
        <Tile
          label="Поступило за период"
          value={total}
          format="rub"
          footer={<span className="text-13 text-fg-secondary">{countLabel(paymentsCount, ["оплата", "оплаты", "оплат"])}</span>}
        />
        <Tile
          label="Средняя оплата"
          value={paymentsCount > 0 ? Math.round(total / paymentsCount) : 0}
          format="rub"
          footer={<span className="text-13 text-fg-secondary">за период</span>}
        />
        <Tile
          label="Наличные в кассе"
          value={cashAvailableCents === null ? 0 : cashAvailableCents / 100}
          format="rub"
          footer={<span className="text-13 text-fg-secondary">{cashAvailableCents === null ? "не загрузились" : "сейчас, до инкассации"}</span>}
        />
        <Tile
          label="Расходы смен"
          value={expensesCents === null ? 0 : expensesCents / 100}
          format="rub"
          footer={<span className="text-13 text-fg-secondary">{expensesCents === null ? "не загрузились" : "за период, отдельно от поступлений"}</span>}
        />
      </section>

      {days.length >= 3 ? (
        <Card title="Поступления по дням" action={<span className="font-semibold tabular-nums text-fg">{formatRub(total)}</span>}>
          <RevenueChart days={days} dayOver={period.to !== todayKey} />
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Как платят">
          <BarList rows={rows(methods)} emptyText="За период оплат нет" />
        </Card>
        <Card title="Куда зачислено">
          <BarList rows={rows(accounts)} emptyText="За период оплат нет" />
        </Card>
      </div>
    </div>
  );
}
