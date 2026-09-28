"use client";

import dynamic from "next/dynamic";
import { Nothing } from "@/lib/nothing";
import Link from "@/components/ui/app-link";
import { useState } from "react";
import clsx from "clsx";
import { ArrowUpRight, Check, ChevronDown, Play, RotateCcw, X } from "lucide-react";

import { RoleOptions, type RoleSwitch } from "@/components/demo/demo-banner";
import { DEMO_SCENARIOS, type DemoScenarioKey } from "@/features/demo/config";

// QR-код записи с телефона — отдельный кусок, только на компьютере.
const BookingQr = dynamic(() => import("@/components/demo/booking-qr").catch(() => ({ default: Nothing })), { ssr: false });

/** Компьютер с мышью: там запись удобнее открыть с телефона по QR-коду. */
function isDesktopPointer() {
  return typeof window !== "undefined" && window.matchMedia("(pointer: fine) and (min-width: 768px)").matches;
}

/**
 * Всё, что витрина предлагает попробовать, — в одной панели за кнопкой «Что
 * попробовать» (на телефоне — лист снизу): первым тур за минуту, затем три
 * сценария (строка раскрывает шаги и кнопку «Начать», у онлайн-записи на
 * компьютере — ещё QR, записаться с телефона) и «Начать заново».
 */
export function ScenariosPanel({
  progress,
  onTour,
  onClose,
  roles,
  reset,
}: {
  progress: Partial<Record<DemoScenarioKey, boolean>>;
  onTour: () => void;
  onClose: () => void;
  roles: RoleSwitch;
  reset: { onReset: () => void; confirming: boolean; resetting: boolean; building: boolean; buildingLabel: string };
}) {
  const [expandedKey, setExpandedKey] = useState<DemoScenarioKey | null>(
    () => DEMO_SCENARIOS.find((scenario) => !progress[scenario.key])?.key ?? null,
  );
  // Панель открывается нажатием — это всегда браузер, не сервер.
  const [desktopPointer] = useState(() => isDesktopPointer());
  return (
    <div
      role="dialog"
      aria-label="Что попробовать"
      className="pop-in fixed inset-x-3 bottom-3 z-[70] max-h-[calc(100dvh-24px)] overflow-y-auto rounded-card bg-bg p-3 text-fg shadow-modal md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-full md:mt-2 md:w-[380px] md:origin-top-right"
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-15 font-semibold">Что попробовать</span>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="inline-flex size-10 items-center justify-center rounded-md text-fg-secondary hover:bg-hover-menu hover:text-fg">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <button type="button" onClick={onTour} className="flex min-h-12 items-center gap-3 rounded-md bg-canvas px-3 py-2 text-left transition-[background-color] motion-fast hover:bg-hover-row">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-white">
            <Play className="size-3 fill-current" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-15 font-medium">Показать за минуту</span>
            <span className="text-13 text-fg-secondary">Путь заказа от кнопки до чека</span>
          </span>
        </button>
        {DEMO_SCENARIOS.map((scenario, index) => {
          const done = Boolean(progress[scenario.key]);
          const expanded = expandedKey === scenario.key;
          const external = scenario.href.startsWith("/book/");
          return (
            <div key={scenario.key} className="rounded-md bg-canvas">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedKey(expanded ? null : scenario.key)}
                className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-[background-color] motion-fast hover:bg-hover-row"
              >
                <span className={clsx("flex size-6 shrink-0 items-center justify-center rounded-full text-13 font-semibold", done ? "bg-accent text-on-accent" : "bg-bg text-fg")}>
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-15 font-medium">{scenario.title}</span>
                  <span className="text-13 text-fg-secondary">{done ? "Пройдено, можно повторить" : `Займёт ${scenario.minutes}`}</span>
                </span>
                <ChevronDown className={clsx("size-4 shrink-0 text-fg-secondary transition-transform motion-fast", expanded && "rotate-180")} aria-hidden="true" />
              </button>
              {expanded ? (
                <div className="px-3 pb-3">
                  <ol className="m-0 flex list-none flex-col gap-2 p-0 pl-9">
                    {scenario.steps.map((step) => (
                      <li key={step} className="list-decimal text-13 leading-snug text-fg-interactive">
                        {step}
                      </li>
                    ))}
                  </ol>
                  <Link
                    href={scenario.href}
                    target={external ? "_blank" : undefined}
                    onClick={onClose}
                    className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent text-15 font-semibold text-on-accent transition-[background-color] motion-fast hover:bg-accent-hover"
                  >
                    {external ? "Открыть страницу записи" : "Начать"}
                    <ArrowUpRight className="size-4" />
                  </Link>
                  {external ? (
                    <p className="m-0 mt-2 text-13 text-fg-secondary">Откроется во вкладке рядом, как у клиента. Потом вернитесь сюда, в «Запись».</p>
                  ) : null}
                  {external && desktopPointer ? <BookingQr path={scenario.href} /> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Телефон: выбора роли в полосе нет — он здесь. */}
      {roles.current ? (
        <div className="mt-3 md:hidden" role="menu" aria-label="Роль">
          <div className="px-1 pb-1 text-13 font-medium text-fg-secondary">Роль</div>
          <RoleOptions roles={roles} onPicked={onClose} />
        </div>
      ) : null}
      {roles.error ? <p className="m-0 mt-2 px-1 text-13 text-status-cancel">{roles.error}</p> : null}

      <button
        type="button"
        onClick={reset.onReset}
        disabled={reset.resetting || reset.building}
        aria-busy={reset.resetting || reset.building || undefined}
        className={clsx(
          "mt-2 flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-15 font-medium transition-[background-color,color] motion-fast",
          reset.confirming ? "bg-accent text-on-accent" : "text-fg-secondary hover:bg-hover-row",
          "disabled:cursor-progress disabled:opacity-70",
        )}
      >
        <RotateCcw className={clsx("size-4 shrink-0", (reset.resetting || reset.building) && "animate-spin [animation-direction:reverse]")} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span>
            {reset.building ? reset.buildingLabel : reset.resetting ? "Начинаем заново…" : reset.confirming ? "Точно начать заново? Нажмите ещё раз" : "Начать заново"}
          </span>
          <span className={clsx("text-13 font-normal", reset.confirming ? "text-on-accent" : "text-fg-secondary")}>
            Данные вернутся к исходным для всех посетителей
          </span>
        </span>
      </button>
    </div>
  );
}
