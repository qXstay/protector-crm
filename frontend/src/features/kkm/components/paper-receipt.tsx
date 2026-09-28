"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import clsx from "clsx";

import { useLiveNow } from "@/components/live/live-time";
import { Check, ReceiptText, X } from "lucide-react";

import { wasOrderJustPaid } from "@/features/orders/payment-confirmation";
import { SHOWCASE_OPERATIONAL_TIME_ZONE } from "@/shared/operational-time";
import { apiRequest } from "@/lib/api/client";
import type { PaperReceipt } from "@/server/repositories/paper-receipt-read-repository";

/**
 * Чек «как на бумаге»: ровно то, что система отправила кассе по оплате
 * заказа, — позиции, скидки, итог, оплаты, признаки расчёта и кассир.
 * Реквизиты, которые касса печатает сама (ФН, ФД, ФП, смена, реквизиты
 * продавца), система кассе не передаёт, поэтому их здесь нет. Сразу после
 * оплаты чек сам выезжает из щели (≈1 с, мягкая подача без тряски), потом его
 * можно открыть кнопкой «Чек» в карточке заказа. При «уменьшении движения»
 * чек просто появляется.
 */

const money = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = (value: number) => money.format(value / 100).replace(/ | /g, " ");

/** Время отправки чека кассе — по времени точек: «26 сент. в 11:59». */
function sentTime(iso: string) {
  const date = new Date(iso);
  const zone = { timeZone: SHOWCASE_OPERATIONAL_TIME_ZONE } as const;
  const day = new Intl.DateTimeFormat("ru-RU", { ...zone, day: "numeric", month: "short" }).format(date);
  const time = new Intl.DateTimeFormat("ru-RU", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${day} в ${time}`;
}

/** Дата и время на ленте, как их печатает касса: «27.09.26 13:00». */
function paperDateTime(iso: string) {
  const date = new Date(iso);
  const zone = { timeZone: SHOWCASE_OPERATIONAL_TIME_ZONE } as const;
  const day = new Intl.DateTimeFormat("ru-RU", { ...zone, day: "2-digit", month: "2-digit", year: "2-digit" }).format(date);
  const time = new Intl.DateTimeFormat("ru-RU", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${day} ${time}`;
}

/**
 * «Передан кассе 5 мин назад» — живая подпись, пока чеку меньше часа; дальше —
 * день и время. Окно чека открывается только в браузере, поэтому запасное
 * «серверное» время (момент отправки) не используется.
 */
function SentLabel({ iso }: { iso: string }) {
  const sentAt = Date.parse(iso);
  const minutes = Math.floor((useLiveNow(sentAt) - sentAt) / 60_000);
  if (minutes >= 0 && minutes < 60) {
    return <>Передан кассе {minutes < 1 ? "только что" : `${minutes} мин назад`}</>;
  }
  return <>Передан кассе {sentTime(iso)}</>;
}

/** Тег 1214 — способ расчёта; тег 1212 — предмет расчёта (ФФД 1.2). */
const PAYMENT_METHOD_LABELS: Record<number, string> = { 4: "полный расчёт" };
const PAYMENT_OBJECT_LABELS: Record<number, string> = { 1: "товар", 4: "услуга" };

function Row({ left, right, strong }: { left: string; right: string; strong?: boolean }) {
  return (
    <div className={clsx("flex items-baseline justify-between gap-3", strong && "font-bold")}>
      <span className="min-w-0">{left}</span>
      <span className="shrink-0 tabular-nums">{right}</span>
    </div>
  );
}

function Rule() {
  return <div aria-hidden="true" className="my-2 border-t border-dashed border-receipt-rule" />;
}

export function PaperReceiptSheet({ receipt, printing }: { receipt: PaperReceipt; printing: boolean }) {
  const cashTotal = receipt.payments.filter((payment) => payment.form === "cash").reduce((sum, payment) => sum + payment.amountCents, 0);
  const cardTotal = receipt.payments.filter((payment) => payment.form === "electronic").reduce((sum, payment) => sum + payment.amountCents, 0);
  const method = receipt.paymentMethodCode !== null ? PAYMENT_METHOD_LABELS[receipt.paymentMethodCode] : undefined;
  const subject = receipt.paymentObjectCode !== null ? PAYMENT_OBJECT_LABELS[receipt.paymentObjectCode] : undefined;

  return (
    <div className="relative mx-auto w-[312px] max-w-full">
      {/* Щель принтера: чек выезжает из-под неё. */}
      <div aria-hidden="true" className="relative z-10 mx-auto h-4 w-[344px] max-w-[calc(100%+32px)] -translate-x-4 rounded-md bg-ink shadow-[0_6px_14px_-6px_rgba(0,0,0,0.6)]">
        <div className="absolute inset-x-5 bottom-1 h-[3px] rounded-full bg-black" />
      </div>
      <div className="relative -mt-2 overflow-hidden px-1 pb-3">
        <div
          className={clsx(
            "receipt-paper relative bg-receipt-paper px-5 pb-8 pt-6 font-mono text-[13px] leading-[1.45] text-receipt-ink shadow-[0_18px_30px_-18px_rgba(22,24,29,0.55)]",
            printing && "receipt-printing",
          )}
          data-paper-receipt={receipt.operationId}
        >
          <Row left="КАССОВЫЙ ЧЕК" right="ПРИХОД" strong />
          {/* На ленте есть дата и время, как на настоящем чеке. */}
          <Row left="Дата" right={paperDateTime(receipt.sentAt)} />
          {receipt.orderNumber ? <Row left="Заказ" right={`№ ${receipt.orderNumber}`} /> : null}
          <Rule />
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {receipt.lines.map((line, index) => (
              <li key={`${line.name}-${index}`}>
                <div className="[overflow-wrap:anywhere]">
                  {index + 1}. {line.name}
                </div>
                <Row left={`   ${line.quantity} × ${cents(line.unitPriceCents)}`} right={cents(line.amountCents + line.discountCents)} />
                {line.discountCents > 0 ? (
                  <>
                    <Row left="   скидка" right={`−${cents(line.discountCents)}`} />
                    <Row left="   к оплате" right={cents(line.amountCents)} />
                  </>
                ) : null}
              </li>
            ))}
          </ol>
          <Rule />
          {receipt.discountCents > 0 ? <Row left="СКИДКА" right={cents(receipt.discountCents)} /> : null}
          <Row left="ИТОГ" right={`≡${cents(receipt.totalCents)}`} strong />
          {cashTotal > 0 ? <Row left="  НАЛИЧНЫМИ" right={`≡${cents(cashTotal)}`} /> : null}
          {cardTotal > 0 ? <Row left="  БЕЗНАЛИЧНЫМИ" right={`≡${cents(cardTotal)}`} /> : null}
          <Rule />
          {method ? <Row left="Способ расчёта" right={method} /> : null}
          {subject ? <Row left="Предмет расчёта" right={subject} /> : null}
          {receipt.cashier ? <Row left="Кассир" right={receipt.cashier} /> : null}
        </div>
      </div>
      <p className="m-0 mt-1 px-2 text-center text-13 leading-snug text-white/70">
        Касса здесь учебная: чек такой же, как на настоящей, но в налоговую не уходит.
      </p>
    </div>
  );
}

function ReceiptDialog({ receipt, printing, onClose }: { receipt: PaperReceipt; printing: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [printed, setPrinted] = useState(!printing);

  useEffect(() => {
    if (printed) return;
    const timer = window.setTimeout(() => setPrinted(true), 1600);
    return () => window.clearTimeout(timer);
  }, [printed]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-scrim-strong px-4 pb-10 pt-16 md:pt-10 [animation:scrim-in_var(--motion-base)_var(--ease-out)_both]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={receipt.orderNumber ? `Чек по заказу № ${receipt.orderNumber}` : "Чек по заказу"}
        className="relative w-full max-w-[380px]"
      >
        <div className="mb-3 flex items-center justify-between text-white">
          <span className="flex items-center gap-2 text-14 font-medium">
            {/* Момент успеха: лента вышла — на месте значка чека появляется
                галочка (та же, что у сообщений об успехе). */}
            {printed && printing ? (
              <span className="pop-in flex size-5 shrink-0 items-center justify-center rounded-full bg-status-paid text-bg" aria-hidden="true">
                <Check className="size-3.5" strokeWidth={3} />
              </span>
            ) : (
              <ReceiptText className="size-4" aria-hidden="true" />
            )}
            {printed ? printing ? "Чек напечатан, можно отдать клиенту" : <SentLabel iso={receipt.sentAt} /> : "Касса печатает чек…"}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Закрыть чек"
            className="inline-flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-[background-color] motion-fast hover:bg-white/20"
          >
            <X className="size-4" />
          </button>
        </div>
        <PaperReceiptSheet receipt={receipt} printing={printing} />
      </div>
    </div>,
    document.body,
  );
}

/**
 * Кнопка «Чек №…» в карточке заказа. Сразу после оплаты (минута) чек
 * открывается сам и «печатается».
 */
export function PaperReceiptTrigger({
  orderId,
  receipts,
  pendingOperationIds = [],
  className,
}: {
  orderId: string;
  receipts: PaperReceipt[];
  /** Операции кассы по заказу, которые ещё печатаются. */
  pendingOperationIds?: string[];
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<{ index: number; printing: boolean } | null>(null);
  const seen = useRef<number | null>(null);
  const pendingKey = pendingOperationIds.join(",");

  // Пока касса печатает, спрашиваем операцию (запрос двигает демо-кассу) и
  // обновляем карточку, когда чек готов.
  useEffect(() => {
    if (!pendingKey) return;
    let cancelled = false;
    let attempts = 0;
    const ids = pendingKey.split(",");
    const tick = async () => {
      attempts += 1;
      try {
        const states = await Promise.all(
          ids.map((id) => apiRequest<{ operation: { status: string } }>(`/api/kkm/operations/${encodeURIComponent(id)}`)),
        );
        if (cancelled) return;
        if (states.every((state) => !["created", "leased", "in_progress"].includes(state.operation.status))) {
          router.refresh();
          return;
        }
      } catch {
        // сеть подведёт — попробуем на следующем круге
      }
      if (!cancelled && attempts < 20) timer = window.setTimeout(tick, 1100);
    };
    let timer = window.setTimeout(tick, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pendingKey, router]);

  // Заказ только что оплачен, а операции кассы в карточке ещё нет (её ставит
  // оплата, карточка могла отрисоваться раньше): несколько раз обновляем
  // карточку — сервер при этом прогоняет демо-кассу, и чек появляется.
  useEffect(() => {
    if (receipts.length > 0 || pendingKey || !wasOrderJustPaid(orderId)) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      router.refresh();
      if (attempts >= 6) window.clearInterval(timer);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [orderId, receipts.length, pendingKey, router]);

  useEffect(() => {
    if (receipts.length === 0) return;
    const previous = seen.current;
    seen.current = receipts.length;
    // Новый чек у только что оплаченного заказа — печать на экране.
    if ((previous === null || receipts.length > previous) && wasOrderJustPaid(orderId)) {
      const timer = window.setTimeout(() => setOpen({ index: receipts.length - 1, printing: true }), 450);
      return () => window.clearTimeout(timer);
    }
  }, [orderId, receipts.length]);

  if (receipts.length === 0) return null;
  const current = open ? receipts[Math.min(open.index, receipts.length - 1)] : null;

  return (
    <>
      {receipts.map((receipt, index) => (
        <button
          key={receipt.operationId}
          type="button"
          onClick={() => setOpen({ index, printing: false })}
          className={className}
          data-paper-receipt-open=""
        >
          <ReceiptText className="size-4" />
          {receipts.length > 1 ? `Чек ${index + 1}` : "Чек"}
        </button>
      ))}
      {current && open ? <ReceiptDialog receipt={current} printing={open.printing} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
