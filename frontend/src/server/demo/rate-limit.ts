import { NextResponse } from "next/server";

import { readClientAddress } from "@/server/api/public-booking-rate-limit";
import { realNowMs } from "@/server/demo/clock";

/**
 * Витрина: потолок частоты для открытой всем демо-версии — только в демо-режиме,
 * настоящая система его не видит.
 *
 * Адрес посетителя читается так же, как у онлайн-записи системы
 * (`readClientAddress`): только из доверенного хвоста `X-Forwarded-For`, число
 * звеньев задаёт `PUBLIC_BOOKING_TRUSTED_PROXY_HOPS` (за Caddy — 1). Без него
 * адреса нет — тогда ключ — сессия посетителя, а без сессии потолка нет:
 * общий счётчик на всех был бы хуже, чем никакого.
 *
 * Потолки с запасом для живого человека и даже офиса за одним адресом, но
 * останавливают скрипт: изменения — 120 в минуту, вход ролью — 60 за 10 минут,
 * «Сбросить демо» (он сбрасывает данные всем посетителям) — 4 за 10 минут.
 * В памяти процесса, как и счётчики онлайн-записи: перезапуск их забывает.
 * Окно — по настоящему времени: «сейчас» сервера витрины сдвигают
 * часы мира, и после ночной пересборки сдвиг меняется — по сдвинутым часам
 * прошлые отметки оказывались «в будущем», и 10 минут окна растягивались
 * на полтора часа.
 */

type Kind = "write" | "login" | "reset";

const LIMITS: Record<Kind, { limit: number; windowMs: number }> = {
  write: { limit: 120, windowMs: 60_000 },
  login: { limit: 60, windowMs: 10 * 60_000 },
  reset: { limit: 4, windowMs: 10 * 60_000 },
};

const buckets = new Map<string, number[]>();
let lastPrune = 0;

function prune(now: number) {
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  const longest = Math.max(...Object.values(LIMITS).map((item) => item.windowMs));
  for (const [key, hits] of buckets) {
    const fresh = hits.filter((timestamp) => timestamp > now - longest);
    if (fresh.length) buckets.set(key, fresh);
    else buckets.delete(key);
  }
}

function visitorKey(headers: Headers, sessionCookie: string | null) {
  const address = readClientAddress(headers);
  if (address) return `ip:${address}`;
  return sessionCookie ? `session:${sessionCookie.slice(0, 32)}` : null;
}

/** `null` — можно; иначе ответ 429 с «Retry-After». */
export function demoRateLimit(kind: Kind, headers: Headers, sessionCookie: string | null): NextResponse | null {
  const key = visitorKey(headers, sessionCookie);
  if (!key) return null;
  const now = realNowMs();
  prune(now);
  const { limit, windowMs } = LIMITS[kind];
  const bucketKey = `${kind}|${key}`;
  const hits = (buckets.get(bucketKey) ?? []).filter((timestamp) => timestamp > now - windowMs);
  if (hits.length >= limit) {
    buckets.set(bucketKey, hits);
    const retryAfter = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    const message =
      kind === "reset"
        ? "Данные недавно обновляли. Попробуйте через несколько минут."
        : "Слишком много действий подряд. Подождите минуту и продолжите.";
    return NextResponse.json({ error: message, reason: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }
  hits.push(now);
  buckets.set(bucketKey, hits);
  return null;
}
