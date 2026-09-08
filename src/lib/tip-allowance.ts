// Buzz-tip caps + the viewer's REAL remaining daily allowance.
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
// 🔴 THE FIX (0.2.10): the remaining daily allowance is READ FROM THE SERVER
// (`GET /api/v1/blocks/tip-allowance`, via `ApiClient.getTipAllowance`) instead
// of being derived from a localStorage running total. The old estimate could
// never work: localStorage throws in the opaque-origin sandbox, so the "spent"
// figure was always 0 and the remaining was always the full cap — and even where
// it did persist it counted only tips made through THIS app on THIS device.
// `readDailySpent` / `recordTipSpend` / `remainingDaily` / `useDailyTipAllowance`
// are gone with it; `TIP_DAILY_MAX` survives only as the fallback ceiling used
// when the server read has not resolved (or failed).
//
// The server stays authoritative for BOTH caps either way — this pre-blocks an
// amount it would reject, it does not decide anything.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from './api.js';

/** Server per-tip cap (`BLOCK_TIP_MAX_PER_TIP`). A single tip cannot exceed this. */
export const TIP_MAX_PER_TIP = 5000;
/** Server per-viewer daily tip ceiling (enforced as a rate limit). */
export const TIP_DAILY_MAX = 25000;
/** The smallest Buzz a single transfer may carry. Also the per-LEG floor of a split. */
export const TIP_MIN = 1;

/** The effective ceiling on a single tip: min(per-tip cap, remaining daily allowance). */
export function effectiveTipCap(dailyRemaining: number): number {
  return Math.max(0, Math.min(TIP_MAX_PER_TIP, dailyRemaining));
}

/** What `useServerTipAllowance` hands the view. */
export interface ServerTipAllowance {
  /**
   * Buzz the viewer may still tip today, or `null` while the read is in flight
   * / after it failed.
   *
   * 🔴 `null` MUST NOT BLOCK TIPPING. A failed allowance read is not evidence
   * the viewer is out of allowance, and the server rejects an over-allowance tip
   * on its own (429 `rate_limited`). Callers pass `remaining ?? undefined` into
   * the pickers, whose `dailyRemaining` default is the full cap — so an unknown
   * allowance degrades to "don't pre-block", never to "can't tip".
   */
  remaining: number | null;
  /** Re-read the allowance. Call after a successful tip. */
  refetch: () => void;
}

/**
 * Read the viewer's real remaining daily tip allowance once per view, and re-read
 * it on demand.
 *
 * 🔴 ONE READ FOR THE WHOLE VIEW, NOT ONE PER CONTROL. Written when there were
 * four tip affordances (`tip-creator`, `tip-curator`, `chrome-tip-curator` and
 * the split popover), each of which would have put an identical GET on the wire
 * for one number that is the same for all of them. T5 left ONE affordance, so
 * the saving is smaller — but the reason to hold the read at App is now
 * stronger, not weaker: `refetch()` after a successful leg has to reach the
 * picker that is still open, and the picker is a child of the view. App holds
 * this hook and threads `remaining` down.
 *
 * Routed through the injected `ApiClient` rather than the SDK's own
 * `useTipAllowance()` on purpose — that hook raw-`fetch`es the host origin,
 * which would bypass the fake every test and the dev harness inject, and lose
 * this client's ApiError taxonomy. Same endpoint, same scope.
 */
export function useServerTipAllowance(api: Pick<ApiClient, 'getTipAllowance'> | null): ServerTipAllowance {
  const [remaining, setRemaining] = useState<number | null>(null);
  // The live client, so `refetch` never closes over a stale one and never has to
  // be re-created (it is a callback dep in App's tip flow).
  const apiRef = useRef(api);
  apiRef.current = api;
  // Bumped by `refetch`; the effect below keys on it so a re-read is one render.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const client = apiRef.current;
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        const allowance = await client.getTipAllowance();
        if (!cancelled) setRemaining(Math.max(0, allowance.remaining));
      } catch {
        // Degrade to "unknown", NOT to zero: the pickers treat `null` as
        // "no local pre-block" and let the server decide.
        if (!cancelled) setRemaining(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { remaining, refetch };
}
