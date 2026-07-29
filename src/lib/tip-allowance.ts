// Buzz-tip caps + an app-local daily-allowance estimate.
//
// The block-tip server enforces TWO limits (mirrored here as constants):
//   - BLOCK_TIP_MAX_PER_TIP = 5000  — the max Buzz in a SINGLE tip.
//   - a daily ceiling        = 25000 — the max Buzz tipped per viewer per day,
//     enforced server-side as a rate limit (429 `rate_limited` + Retry-After).
//
// 🔴 THE FIX (v0.1.9): the client TIP_MAX was 100000 — 20× the server per-tip
// cap — so the picker happily accepted an amount the server would always reject,
// wasting a round-trip and confusing the user. Client validation now caps at the
// real per-tip limit BEFORE the request.
//
// The server stays authoritative for BOTH caps. `remainingDaily` is a
// best-effort, APP-LOCAL estimate (it only counts tips made through THIS app on
// THIS device, persisted in localStorage) used to surface "how much of your
// daily tip allowance is left" and to pre-block an obviously over-allowance
// amount. A genuine daily-cap breach still surfaces as the server's
// `rate_limited` path — never a silent success.

import { useCallback, useState } from 'react';

import { getLocalStorage } from '../settings.js';

/** Server per-tip cap (`BLOCK_TIP_MAX_PER_TIP`). A single tip cannot exceed this. */
export const TIP_MAX_PER_TIP = 5000;
/** Server per-viewer daily tip ceiling (enforced as a rate limit). */
export const TIP_DAILY_MAX = 25000;

const KEY_PREFIX = 'playable-collections:tips:';

/** UTC calendar-day key so the app-local running total resets each day. */
function dayKey(now: number): string {
  return KEY_PREFIX + new Date(now).toISOString().slice(0, 10);
}

/** App-local Buzz tipped so far TODAY (this device). Missing/corrupt → 0. */
export function readDailySpent(storage: Storage | null = getLocalStorage(), now: number = Date.now()): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(dayKey(now));
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Add a successful tip to today's app-local running total. Returns the new total. */
export function recordTipSpend(amount: number, storage: Storage | null = getLocalStorage(), now: number = Date.now()): number {
  const next = readDailySpent(storage, now) + Math.max(0, Math.floor(amount));
  try {
    storage?.setItem(dayKey(now), String(next));
  } catch {
    /* ignore */
  }
  return next;
}

/** Estimated Buzz still available in today's tip allowance (never negative). */
export function remainingDaily(storage: Storage | null = getLocalStorage(), now: number = Date.now()): number {
  return Math.max(0, TIP_DAILY_MAX - readDailySpent(storage, now));
}

/** The effective ceiling on a single tip: min(per-tip cap, remaining daily allowance). */
export function effectiveTipCap(dailyRemaining: number): number {
  return Math.max(0, Math.min(TIP_MAX_PER_TIP, dailyRemaining));
}

/**
 * React hook: the estimated remaining daily tip allowance + a `record` setter to
 * call after a successful tip (so the next tip modal reflects the new remaining).
 */
export function useDailyTipAllowance(storage: Storage | null = getLocalStorage()): {
  remaining: number;
  record: (amount: number) => void;
} {
  const [remaining, setRemaining] = useState<number>(() => remainingDaily(storage));
  const record = useCallback(
    (amount: number) => {
      recordTipSpend(amount, storage);
      setRemaining(remainingDaily(storage));
    },
    [storage],
  );
  return { remaining, record };
}
