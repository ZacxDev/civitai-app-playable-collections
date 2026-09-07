// The %-split tip: how one press of Buzz is divided between the creator of the
// media on screen and the curator of the collection (operator feedback round 3).
//
// This module is the MONEY MATH and nothing else — pure functions, no React, no
// network. The popover (../components/TipSplitModal.tsx) renders what these
// return, and App sends each leg through `ApiClient.tip`.
//
// 🔴 THE TOTAL IS CAPPED AT 5,000, NOT EACH LEG. `TIP_MAX_PER_TIP` is the
// SERVER's per-transfer limit; a two-leg split therefore passes its gate at
// 10,000 Buzz from a single press. The store description promises "up to 5,000
// Buzz per tip in total", and that is the promise this file keeps —
// `TIP_TOTAL_MAX` is the cap on the SUM, and it is deliberately the same number
// so a one-leg split is unchanged from the single-target picker.
//
// 🔴 EVERY LEG THAT EXISTS CARRIES AT LEAST `TIP_MIN`. A percentage applied to a
// small total rounds: 1% of 50 is 0.5, and 99% of 50 leaves 0.5 for the other
// side. A leg of 0 is not a tip — the server rejects a non-positive amount — so
// a rounded-to-nothing leg is CLAMPED UP to `TIP_MIN` and the Buzz comes out of
// the other leg, keeping the sum exactly equal to the requested total. Below
// `2 × TIP_MIN` no two-way split exists at all, and the plan comes back empty so
// the caller refuses instead of sending a zero.
//
// A 100/0 or 0/100 split is NOT a rounding failure — it is the viewer choosing
// one recipient — so it yields ONE leg carrying the whole total, never a leg of
// 0 alongside it.

import { TIP_DAILY_MAX, TIP_MAX_PER_TIP, TIP_MIN } from './tip-allowance.js';

export { TIP_MIN };

/** The cap on the SUM of both legs of one press. See the header. */
export const TIP_TOTAL_MAX = TIP_MAX_PER_TIP;

/** Default share for the creator of the media on screen (the rest goes to the curator). */
export const DEFAULT_CREATOR_PERCENT = 50;

export type TipLegKind = 'creator' | 'curator';

/** One transfer of a split: who, and how much. */
export interface TipLeg {
  kind: TipLegKind;
  amount: number;
}

/** Which sides may legally receive Buzz from this viewer, right now. */
export interface TipEligibility {
  /**
   * There is a creator to tip AND it is not the viewer. The server 403s a
   * self-tip, so a collapsed leg is the difference between a split that works
   * and one that half-fails after taking the viewer's confirmation.
   */
  creatorEligible: boolean;
  /** There is a curator to tip AND it is not the viewer. */
  curatorEligible: boolean;
}

/**
 * Divide `total` Buzz between the two sides, honouring eligibility, the per-leg
 * minimum, and the exact sum.
 *
 * Returns the legs in send order (creator first), or an EMPTY array when no
 * sendable plan exists — either because neither side is eligible, or because the
 * total is too small to give both sides `TIP_MIN`. An empty plan is the caller's
 * signal to refuse; `validateTipSplit` turns it into the message to show.
 *
 * The returned amounts always sum to exactly `total` (the clamp moves Buzz
 * between the legs, it never creates or destroys any).
 */
export function splitTipTotal(total: number, creatorPercent: number, eligibility: TipEligibility): TipLeg[] {
  const { creatorEligible, curatorEligible } = eligibility;
  if (!Number.isInteger(total) || total < TIP_MIN) return [];
  if (!creatorEligible && !curatorEligible) return [];
  // A collapsed side takes the whole total — this is hazard 3 (self-tip) and the
  // "no media on screen" case, and it is why the popover never offers to send
  // Buzz to the viewer themselves.
  if (!creatorEligible) return [{ kind: 'curator', amount: total }];
  if (!curatorEligible) return [{ kind: 'creator', amount: total }];
  // A deliberate one-sided split: one leg, the whole total, no 0-Buzz companion.
  if (creatorPercent >= 100) return [{ kind: 'creator', amount: total }];
  if (creatorPercent <= 0) return [{ kind: 'curator', amount: total }];
  // Two legs — each needs TIP_MIN, so the smallest splittable total is 2.
  if (total < 2 * TIP_MIN) return [];
  let creator = Math.round((total * creatorPercent) / 100);
  // Clamp both directions. Only one of these can fire (a total of >= 2 cannot be
  // short at both ends), and the other leg absorbs the difference so the sum holds.
  if (creator < TIP_MIN) creator = TIP_MIN;
  if (total - creator < TIP_MIN) creator = total - TIP_MIN;
  return [
    { kind: 'creator', amount: creator },
    { kind: 'curator', amount: total - creator },
  ];
}

/**
 * Validate a requested split TOTAL against every gate a press must clear:
 * shape, the per-press total cap, the viewer's remaining daily allowance, their
 * Buzz balance, and the per-leg minimum. Returns the message to show, or `null`
 * when the press may go ahead.
 *
 * `dailyRemaining` defaults to the full daily cap so an UNRESOLVED or FAILED
 * allowance read cannot pre-block a tip the server would have accepted.
 */
export function validateTipSplit(
  raw: string,
  balance: number | null,
  creatorPercent: number,
  eligibility: TipEligibility,
  dailyRemaining: number = TIP_DAILY_MAX,
): string | null {
  const n = Number(raw);
  if (!raw.trim()) return 'Enter an amount.';
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Amount must be a whole number.';
  if (n < TIP_MIN) return `Minimum tip is ${TIP_MIN} Buzz.`;
  if (n > TIP_TOTAL_MAX) return `Maximum is ${TIP_TOTAL_MAX.toLocaleString()} Buzz per tip in total.`;
  if (n > dailyRemaining) return `Only ${dailyRemaining.toLocaleString()} Buzz left in today's tip allowance.`;
  if (balance != null && n > balance) return `That's more than your ${balance.toLocaleString()} Buzz balance.`;
  const legs = splitTipTotal(n, creatorPercent, eligibility);
  if (legs.length === 0) {
    if (!eligibility.creatorEligible && !eligibility.curatorEligible) return 'There is no one to tip here.';
    return `A split needs at least ${2 * TIP_MIN} Buzz — ${TIP_MIN} for each side.`;
  }
  return null;
}

/**
 * Mint a key identifying ONE leg of ONE logical tip.
 *
 * 🔴 MINT ONCE PER LOGICAL TIP, REUSE ON RETRY. The server replays the first
 * terminal result for a repeated key, so re-sending a leg whose response was
 * LOST collapses to one transfer. Minting a fresh key on the retry is exactly
 * the double-spend the field exists to prevent — and from inside the iframe a
 * lost response is indistinguishable from a rejection, which is precisely where
 * the retry button lives.
 */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `tip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
