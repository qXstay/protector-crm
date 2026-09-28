"use client";

import dynamic from "next/dynamic";
import { Nothing } from "@/lib/nothing";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import clsx from "clsx";
import { Check, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";

import { COMMAND_EVENT, type CommandRequest } from "@/components/command/command-events";
import { ShowcaseStripText } from "@/components/demo/showcase-strip-text";
import { useDashboardAuth } from "@/components/layout/dashboard-shell";
import { setDemoAuthContextCache } from "@/features/auth/storage";
import type { DemoAuthContext } from "@/features/auth/types";

import { apiRequest } from "@/lib/api/client";
import {
  DEMO_PROGRESS_EVENT,
  DEMO_PROGRESS_STORAGE_KEY,
  DEMO_ROLES,
  DEMO_SCENARIOS,
  demoRoleOfEmployee,
  readDemoScenarioProgress,
  type DemoRole,
  type DemoScenarioKey,
} from "@/features/demo/config";

/**
 * Полоса витрины над приложением — одна тонкая строка, одинаковая в обеих
 * темах: честная подпись, выбор роли и «Что попробовать» (тур за минуту, три
 * сценария с галочками — ставятся сами, когда посетитель дошёл до конца, — и
 * «Начать заново»). Сворачивается в маленькую кнопку в углу; выбор помнит
 * браузер. Больше слово «демо» в интерфейсе нигде не стоит.
 */

const COLLAPSE_KEY = "protektor-demo-banner";
/** «Данные обновлены» после полной загрузки страницы (пересборка мира). */
const WORLD_UPDATED_KEY = "protektor-world-updated";

/**
 * После пересборки мира — полная загрузка страницы, а не переход
 * роутера. Часы мира страница берёт только при загрузке (demo-clock-script),
 * а пересборка меняет их сдвиг: вкладка на старых часах считала кассу
 * молчащей («Касса не на связи с …») и не показывала чек.
 */
function reloadWorld(path: string | null) {
  try {
    window.sessionStorage.setItem(WORLD_UPDATED_KEY, "1");
  } catch {
    // без хранилища просто не будет сообщения
  }
  if (path) window.location.assign(path);
  else window.location.reload();
}
const TOUR_SEEN_KEY = "protector-tour-seen";

// Тур и панель «Что попробовать» — отдельные куски, грузятся по первому
// действию (панель — заранее, как только курсор или палец у кнопки).
// Не загрузился кусок — его просто нет, экран не падает (`Nothing`).
const Tour = dynamic(() => import("@/components/demo/tour").catch(() => ({ default: Nothing })), { ssr: false });
const loadScenariosPanel = () => import("@/components/demo/scenarios-panel");
const ScenariosPanel = dynamic(
  () =>
    loadScenariosPanel()
      .then((module) => module.ScenariosPanel)
      .catch(() => Nothing),
  { ssr: false },
);

// Раз в минуту и при возврате на вкладку (Автопилот): после пересборки мира
// открытая вкладка узнаёт об этом быстро и уходит на стартовый экран.
const STATUS_POLL_MS = 60_000;

/** Как называется роль в кнопке выбора: с большой буквы, коротко. */
const ROLE_LABELS: Record<DemoRole, string> = {
  owner: "Владелец",
  manager: "Управляющий",
  employee: "Администратор точки",
};

type DemoStatus = {
  building: boolean;
  progress: number;
  label: string;
  world: { dayKey: string; builtAt: string } | null;
  /** Метка последней пересборки мира: сменилась — данные вкладки устарели. */
  rebuiltAt?: string | null;
};

function subscribeProgress(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DEMO_PROGRESS_STORAGE_KEY || event.key === COLLAPSE_KEY) onChange();
  };
  window.addEventListener(DEMO_PROGRESS_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(DEMO_PROGRESS_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function readProgressSnapshot() {
  return JSON.stringify(readDemoScenarioProgress());
}

function readCollapsedSnapshot() {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/**
 * Галочки сценариев живут в браузере посетителя (localStorage) — читаем их
 * как внешнее хранилище; «только что пройден» ловим событием отметки.
 */
function useScenarioProgress() {
  const snapshot = useSyncExternalStore(subscribeProgress, readProgressSnapshot, () => "{}");
  const progress = JSON.parse(snapshot) as Partial<Record<DemoScenarioKey, boolean>>;
  const [justDone, setJustDone] = useState<DemoScenarioKey | null>(null);

  useEffect(() => {
    const onLocal = (event: Event) => {
      const key = (event as CustomEvent<{ key: DemoScenarioKey | null }>).detail?.key ?? null;
      if (key) setJustDone(key);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DEMO_PROGRESS_STORAGE_KEY || !event.newValue) return;
      const before = JSON.parse(event.oldValue ?? "{}") as Record<string, boolean>;
      const after = JSON.parse(event.newValue) as Record<string, boolean>;
      const done = DEMO_SCENARIOS.find((scenario) => after[scenario.key] && !before[scenario.key]);
      if (done) setJustDone(done.key);
    };
    window.addEventListener(DEMO_PROGRESS_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DEMO_PROGRESS_EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return { progress, justDone, clearJustDone: () => setJustDone(null) };
}

/**
 * Смена роли одним нажатием: тот же вход, что на странице входа, и сразу на
 * первый экран этой роли.
 */
function useRoleSwitch() {
  const router = useRouter();
  const auth = useDashboardAuth();
  const current = demoRoleOfEmployee(auth?.session.currentEmployeeId);
  const [busy, setBusy] = useState<DemoRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  const switchTo = useCallback(
    async (role: DemoRole) => {
      if (busy || role === current) return;
      setBusy(role);
      setError(null);
      try {
        const result = await apiRequest<{ ok: true; context: DemoAuthContext }>("/api/auth/demo", {
          method: "POST",
          body: JSON.stringify({ role }),
        });
        setDemoAuthContextCache(result.context);
        router.replace("/summary");
        router.refresh();
      } catch {
        setError("Не получилось сменить роль, попробуйте ещё раз");
      } finally {
        setBusy(null);
      }
    },
    [busy, current, router],
  );

  return { current, busy, error, switchTo };
}

export type RoleSwitch = ReturnType<typeof useRoleSwitch>;

export function RoleOptions({ roles, onPicked }: { roles: RoleSwitch; onPicked?: () => void }) {
  return (
    <>
      {DEMO_ROLES.map((role) => {
        const selected = roles.current === role.role;
        return (
          <button
            key={role.role}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            disabled={roles.busy !== null}
            onClick={() => {
              void roles.switchTo(role.role);
              onPicked?.();
            }}
            className={clsx(
              "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-[background-color] motion-fast disabled:cursor-progress",
              selected ? "bg-accent-soft" : "hover:bg-hover-row",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-15 font-medium text-fg">{roles.busy === role.role ? "Входим…" : ROLE_LABELS[role.role]}</span>
              <span className="text-13 text-fg-secondary">{role.person}</span>
            </span>
            {selected ? <Check className="size-4 shrink-0 text-accent" strokeWidth={2.4} /> : null}
          </button>
        );
      })}
    </>
  );
}

/** Выбор роли в полосе (на компьютере; на телефоне он в «Что попробовать»). */
function RoleMenu({ roles }: { roles: RoleSwitch }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!roles.current) return null;

  return (
    <div ref={rootRef} className="relative shrink-0 max-md:hidden">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={clsx(
          "flex h-8 items-center gap-1.5 rounded-full pl-3 pr-2.5 text-14 font-medium text-frame-fg transition-[background-color] motion-fast",
          open ? "bg-frame-active" : "hover:bg-frame-hover",
        )}
      >
        <span className="text-frame-fg-secondary">Роль:</span>
        {ROLE_LABELS[roles.current]}
        <ChevronDown className={clsx("size-3.5 text-frame-fg-secondary transition-transform motion-fast", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Роль"
          className="pop-in absolute right-0 top-full z-[70] mt-2 w-[260px] origin-top-right rounded-card bg-bg p-1.5 text-fg shadow-modal"
        >
          <RoleOptions roles={roles} onPicked={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 4200);
    return () => window.clearTimeout(timer);
  }, [text, onDone]);
  return (
    <div
      role="status"
      className="rise-in fixed bottom-6 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2.5 rounded-full bg-ink py-2.5 pl-3 pr-4 text-14 font-medium text-white shadow-modal max-md:bottom-[calc(84px+env(safe-area-inset-bottom))]"
    >
      {/* Успех — тот же зелёный кружок с галочкой, что у сообщений системы. */}
      <span className="pop-in flex size-5 items-center justify-center rounded-full bg-status-paid text-bg">
        <Check className="size-3.5" strokeWidth={3} />
      </span>
      {text}
    </div>
  );
}

/**
 * Витрина: Закреплённая полоса экрана внизу (итоги смены, страницы
 * списка) — свёрнутая кнопка витрины встаёт над ней и не закрывает «Вперёд»
 * и суммы. Нижнюю панель заказа считают свои переменные (`--order-panel-h`,
 * `--phone-pay-bar`). Полосы нет или она не закреплена — подъём 0.
 */
function usePinnedBarLift(enabled: boolean) {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const main = document.getElementById("demo-main");
    if (!enabled || !main) return;
    let frame = 0;
    let bar: HTMLElement | null = null;
    const sizes = new ResizeObserver(() => measure());
    function measure() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const next =
          [...main!.querySelectorAll<HTMLElement>(".demo-bar:not([data-order-bottom-panel])")].find(
            (node) => node.offsetHeight > 0 && getComputedStyle(node).position === "sticky",
          ) ?? null;
        if (next !== bar) {
          if (bar) sizes.unobserve(bar);
          if (next) sizes.observe(next);
          bar = next;
        }
        setLift(next ? next.offsetHeight : 0);
      });
    }
    // Полоса приходит и уходит вместе с экраном — смотрим только на неё.
    const touchesBar = (nodes: NodeList) =>
      [...nodes].some((node) => node instanceof Element && (node.matches(".demo-bar") || node.querySelector(".demo-bar") !== null));
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => touchesBar(record.addedNodes) || touchesBar(record.removedNodes))) measure();
    });
    mutations.observe(main, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      window.cancelAnimationFrame(frame);
      mutations.disconnect();
      sizes.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled]);
  return enabled ? lift : 0;
}

export function DemoBanner() {
  const { progress, justDone, clearJustDone } = useScenarioProgress();
  const storedCollapsed = useSyncExternalStore(subscribeProgress, readCollapsedSnapshot, () => false);
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  const collapsed = collapsedOverride ?? storedCollapsed;
  const pinnedBarLift = usePinnedBarLift(collapsed);
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const doneCount = DEMO_SCENARIOS.filter((scenario) => progress[scenario.key]).length;
  const pathname = usePathname();
  const [tourOpen, setTourOpen] = useState(false);
  const roles = useRoleSwitch();

  const openTour = useCallback(() => {
    setPanelOpen(false);
    setTourOpen(true);
    try {
      window.localStorage.setItem(TOUR_SEEN_KEY, "1");
    } catch {
      // без хранилища тур просто может показаться ещё раз
    }
  }, []);

  const closeTour = useCallback(() => setTourOpen(false), []);

  // «Показать за минуту» из палитры команд.
  useEffect(() => {
    const onRequest = (event: Event) => {
      if ((event as CustomEvent<CommandRequest>).detail === "tour") openTour();
    };
    window.addEventListener(COMMAND_EVENT, onRequest);
    return () => window.removeEventListener(COMMAND_EVENT, onRequest);
  }, [openTour]);

  // Первый заход на сводку — тур сам, один раз: он и предлагает начать с
  // заказа. Под автоматизацией (тесты, съёмка) — нет: он перекрыл бы экран.
  useEffect(() => {
    if (pathname !== "/summary" || navigator.webdriver) return;
    let seen = false;
    try {
      seen = window.localStorage.getItem(TOUR_SEEN_KEY) === "1";
    } catch {
      seen = true;
    }
    if (seen) return;
    const timer = window.setTimeout(() => {
      if (!document.querySelector('[role="dialog"][aria-modal="true"]')) openTour();
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [pathname, openTour]);

  // Автопилот: мир пересобрали (тихо, по сроку, утром или кто-то нажал
  // «Начать заново») — открытая вкладка не падает на исчезнувших заказах, а
  // мягко уходит на стартовый экран с подписью «Данные обновлены».
  const worldMarkRef = useRef<string | null>(null);
  const leaveToStart = useCallback(() => reloadWorld("/summary"), []);

  useEffect(() => {
    let flagged = false;
    try {
      flagged = window.sessionStorage.getItem(WORLD_UPDATED_KEY) === "1";
      if (flagged) window.sessionStorage.removeItem(WORLD_UPDATED_KEY);
    } catch {
      // без хранилища — без сообщения
    }
    if (!flagged) return;
    const frame = window.requestAnimationFrame(() => setToast("Данные обновлены"));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const pollStatus = useCallback(async () => {
    try {
      const next = await apiRequest<DemoStatus>("/api/demo/status");
      setStatus(next);
      const mark = next.building ? null : (next.rebuiltAt ?? null);
      if (mark) {
        const seen = worldMarkRef.current;
        worldMarkRef.current = mark;
        if (seen && seen !== mark) leaveToStart();
      }
      return next;
    } catch {
      return null;
    }
  }, [leaveToStart]);

  useEffect(() => {
    void pollStatus();
    const timer = window.setInterval(() => void pollStatus(), STATUS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pollStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollStatus]);

  // Пока идёт сборка — спрашиваем чаще; когда закончится, опрос увидит новую
  // метку мира и сам уведёт на стартовый экран. Первая сборка (метки ещё не
  // было) — просто обновить экран.
  useEffect(() => {
    if (!status?.building) return;
    const firstWorld = worldMarkRef.current === null;
    const timer = window.setInterval(async () => {
      const next = await pollStatus();
      if (next && !next.building && firstWorld) reloadWorld(null);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [status?.building, pollStatus]);

  // Сообщение о пройденном сценарии не ложится поверх окна
  // (после оплаты — чек): ждёт, пока окно закроют, не дольше двух минут.
  // Первая проверка — через 2,5 с: между окном оплаты и чеком есть переход,
  // в который окон на экране нет.
  const [pendingDone, setPendingDone] = useState<string | null>(null);
  useEffect(() => {
    if (!justDone) return;
    const scenario = DEMO_SCENARIOS.find((item) => item.key === justDone);
    if (scenario) setPendingDone(scenario.done);
    clearJustDone();
  }, [justDone, clearJustDone]);
  useEffect(() => {
    if (!pendingDone) return;
    const dialogOpen = () => Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
    const startedAt = Date.now();
    const show = () => {
      setToast(pendingDone);
      setPendingDone(null);
    };
    const timer = window.setInterval(() => {
      const waited = Date.now() - startedAt;
      if (waited > 120_000) {
        window.clearInterval(timer);
        setPendingDone(null);
      } else if (waited >= 2_500 && !dialogOpen()) {
        window.clearInterval(timer);
        show();
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [pendingDone]);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  useEffect(() => {
    if (!panelOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setPanelOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanelOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [panelOpen]);

  function setCollapsedPersisted(next: boolean) {
    setCollapsedOverride(next);
    setPanelOpen(false);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? "collapsed" : "open");
    } catch {
      // только удобство
    }
  }

  async function handleReset() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setResetting(true);
    try {
      const result = await apiRequest<{ mode: "restored" | "building" }>("/api/demo/reset", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (result.mode === "building") {
        setStatus((current) => ({ ...(current ?? { world: null, label: "", progress: 0 }), building: true }));
        setToast("Готовим данные, это пара минут");
      } else {
        // «Начать заново» — со стартового экрана; новая метка мира берётся
        // следующим опросом без второго ухода.
        worldMarkRef.current = null;
        leaveToStart();
        void pollStatus();
      }
    } catch {
      setToast("Не получилось, попробуйте ещё раз");
    } finally {
      setResetting(false);
    }
  }

  const building = Boolean(status?.building);

  if (collapsed) {
    return (
      <>
        {/* Под окнами (z-50): свёрнутая кнопка не закрывает их кнопки в углу
            («Принять» в окне оплаты); над нижней панелью заказа на компьютере,
            над полосой оплаты на телефоне (переменные ставит phone-pay-bar) и
            над закреплённой полосой экрана (итоги, страницы — usePinnedBarLift);
            пока на экране «Принято …» после оплаты (в том же углу) — кнопка прячется. */}
        <button
          type="button"
          onClick={() => setCollapsedPersisted(false)}
          className="rise-in fixed bottom-5 right-5 z-[45] flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-13 font-medium text-white shadow-modal transition-[background-color] motion-fast hover:bg-ink-hover md:bottom-[calc(1.25rem+var(--order-panel-h,0px)+var(--pinned-bar,0px))] [html:has([data-payment-confirmation])_&]:invisible max-md:bottom-[calc(76px+var(--phone-pay-bar,0px)+var(--pinned-bar,0px)+env(safe-area-inset-bottom))] max-md:right-3"
          style={{ "--pinned-bar": `${pinnedBarLift}px` } as CSSProperties}
          data-demo-pill=""
          aria-label="Показать плашку витрины"
          data-tour="scenarios"
        >
          Витрина
          <span className={clsx("tnum", doneCount > 0 ? "text-accent-graphic" : "text-white/60")}>
            {doneCount}/{DEMO_SCENARIOS.length}
          </span>
        </button>
        {toast ? <Toast text={toast} onDone={() => setToast(null)} /> : null}
        {tourOpen ? <Tour onClose={closeTour} /> : null}
      </>
    );
  }

  const buildingLabel = `Готовим данные${status?.progress ? `, ${Math.round(status.progress * 100)} %` : "…"}`;

  return (
    <div
      ref={rootRef}
      data-demo-banner=""
      className="relative z-[45] flex min-h-11 shrink-0 items-center gap-2 bg-frame px-4 text-13 text-frame-fg-secondary max-md:min-h-12 max-md:px-3 max-[399px]:gap-1 md:pl-5"
    >
      <span className="flex min-w-0 flex-1 items-center">
        {resetting || building ? (
          // Пока готовятся данные — это и есть главное сообщение полосы.
          <span className="flex min-w-0 items-center gap-2 text-frame-fg" role="status">
            <RotateCcw aria-hidden="true" className="size-3.5 shrink-0 animate-spin [animation-direction:reverse]" />
            <span className="truncate">{building ? buildingLabel : "Начинаем заново…"}</span>
          </span>
        ) : (
          <ShowcaseStripText />
        )}
      </span>

      <RoleMenu roles={roles} />

      {/* Один вход во всё, что витрина предлагает попробовать, — на всех ширинах. */}
      <div className="relative shrink-0" data-tour="scenarios">
        <button
          type="button"
          aria-expanded={panelOpen}
          aria-haspopup="dialog"
          onPointerEnter={() => void loadScenariosPanel()}
          onFocus={() => void loadScenariosPanel()}
          onClick={() => setPanelOpen(!panelOpen)}
          className={clsx(
            "touch-target flex h-8 items-center gap-2 rounded-full pl-3 pr-2.5 text-14 font-medium text-frame-fg transition-[background-color] motion-fast max-md:h-9 max-[399px]:px-2",
            panelOpen ? "bg-frame-active" : "bg-frame-raised hover:bg-frame-active",
          )}
        >
          Что попробовать{" "}
          <span className={clsx("tnum max-[399px]:hidden", doneCount > 0 ? "text-accent-graphic" : "text-frame-fg-secondary")}>
            {doneCount}/{DEMO_SCENARIOS.length}
          </span>
          {/* Уже 400 px стрелка уступает место честной подписи слева. */}
          <ChevronDown className={clsx("size-3.5 text-frame-fg-secondary transition-transform motion-fast max-[399px]:hidden", panelOpen && "rotate-180")} aria-hidden="true" />
        </button>
        {panelOpen ? (
          <ScenariosPanel
            progress={progress}
            onTour={openTour}
            onClose={() => setPanelOpen(false)}
            roles={roles}
            reset={{ onReset: () => void handleReset(), confirming, resetting, building, buildingLabel }}
          />
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => setCollapsedPersisted(true)}
        aria-label="Свернуть плашку"
        title="Свернуть плашку"
        className="touch-target flex size-8 shrink-0 items-center justify-center rounded-full text-frame-fg-secondary transition-[background-color,color] motion-fast hover:bg-frame-hover hover:text-frame-fg max-md:size-9"
      >
        <ChevronUp className="size-4" />
      </button>

      {toast ? <Toast text={toast} onDone={() => setToast(null)} /> : null}
      {tourOpen ? <Tour onClose={closeTour} /> : null}
    </div>
  );
}
