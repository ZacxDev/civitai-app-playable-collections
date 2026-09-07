// Content maturity, decided by the PLATFORM'S ceiling — not by this app.
//
// 🔴 THIS FILE USED TO SAY THE OPPOSITE, AND THE OLD RATIONALE IS WHY THE APP
// GREW A CONSENT MECHANISM IT HAD NO BUSINESS OWNING. It read: "we do NOT assume
// the block media API clamps reads by the viewer's browsing level (no evidence it
// does)", and from that assumption the app built a session-level "I'm 18+" gate,
// a blur-until-tap overlay on the player and a second, age-less tap-to-reveal on
// the grid covers.
//
// The assumption is FALSE and the evidence now exists in the host:
//   - the detail endpoint threads the token's clamped `browsingLevel` into the
//     collection-item read, so items arrive already filtered (civitai #4660);
//   - a discovery cover is clamped by the same bitmask and the level of the image
//     actually served is published as `coverNsfwLevel` (civitai #4663,
//     `toCoverFields` / `getFallbackCoverImages`);
//   - the host projects the domain's ceiling into `BLOCK_INIT` as
//     `maxBrowsingLevel`, which the SDK exposes via `useDomainMaturity()`.
//
// So maturity is the viewer's own NSFW viewing level, set by the native control
// in the civitai site header and enforced server-side. The app's job is to RENDER
// that decision, never to re-ask it: an item the ceiling excludes is not shown at
// all, and there is no affordance anywhere that reveals one.
//
// Civitai `nsfwLevel` is a power-of-two tier (PG=1, PG-13=2, R=4, X=8, XXX=16);
// values can be OR'd, so the badge buckets by the HIGHEST tier present. Pure +
// tested.

import { isLevelAllowed } from '@civitai/app-sdk/blocks';

export type MaturityBucket = 'pg' | 'pg13' | 'r' | 'x' | 'xxx' | 'unknown';

const PG13 = 2;
const R = 4;
const X = 8;
const XXX = 16;

/**
 * Is an item at `nsfwLevel` permitted by the platform's `ceiling` bitmask?
 * This is the ONE predicate the whole app renders from.
 *
 * 🔴 FAILS CLOSED, THREE WAYS, AND ALL THREE ARE LOAD-BEARING:
 *   - an ABSENT level (`undefined`) is not a claim, so it is not permitted. The
 *     only field that can be absent is `CollectionSummary.coverNsfwLevel`, and
 *     against a #4663 host it is absent exactly when there is NO COVER, which the
 *     caller already renders as a placeholder tile. Against an older host it
 *     degrades a cover to that same placeholder rather than painting an image
 *     whose rating nobody stated.
 *   - an UNRATED / malformed level (`0`, `NaN`, negative) is not permitted, on
 *     every ceiling. Note this is deliberately STRICTER than the server, whose
 *     item query keeps `nsfwLevel = 0` rows; being stricter is the safe direction
 *     and matches what this app has always done with an unrated item.
 *   - an ABSENT ceiling (before `BLOCK_INIT` lands, or a host predating civitai
 *     #2670) permits SFW levels only. That posture is the SDK's, not ours —
 *     `isLevelAllowed` owns it, so the app cannot drift from the platform.
 *
 * The test is CONTAINMENT (`ceiling & level === level`), so an OR'd level is
 * permitted only when every bit it sets is permitted.
 */
export function withinCeiling(
  nsfwLevel: number | undefined,
  ceiling: number | undefined,
): nsfwLevel is number {
  if (nsfwLevel === undefined) return false;
  return isLevelAllowed(nsfwLevel, ceiling);
}

/** Drop every item the ceiling excludes. The list a surface may render. */
export function filterToCeiling<T extends { nsfwLevel: number }>(
  items: readonly T[],
  ceiling: number | undefined,
): T[] {
  return items.filter((item) => withinCeiling(item.nsfwLevel, ceiling));
}

/** Bucket a raw `nsfwLevel` bitmask into its highest maturity tier. */
export function maturityBucket(nsfwLevel: number): MaturityBucket {
  // Total over every number, so `0` / malformed has to map somewhere. Such an
  // item is never rendered (`withinCeiling` refuses it), so this bucket reaches
  // a badge only if a future caller labels something it did not first permit.
  if (!Number.isFinite(nsfwLevel) || nsfwLevel <= 0) return 'unknown';
  const n = nsfwLevel;
  if (n >= XXX) return 'xxx';
  if (n >= X) return 'x';
  if (n >= R) return 'r';
  if (n >= PG13) return 'pg13';
  return 'pg';
}

const LABELS: Record<MaturityBucket, string> = {
  pg: 'PG',
  pg13: 'PG-13',
  r: 'R',
  x: 'X',
  xxx: 'XXX',
  // Neutral rather than the alarming "NSFW": an unrated level means "we could not
  // confirm a rating", not "this is explicit".
  unknown: 'Unrated',
};

/** Human rating label for the badge (e.g. `R`, `XXX`). */
export function maturityLabel(nsfwLevel: number): string {
  return LABELS[maturityBucket(nsfwLevel)];
}

/**
 * Whether a maturity badge is worth showing at all (anything above PG).
 *
 * 🔴 A BADGE IS NOT A GATE. It labels content the platform has already decided
 * the viewer may see; it hides nothing and reveals nothing.
 */
export function hasMaturityBadge(nsfwLevel: number): boolean {
  return maturityBucket(nsfwLevel) !== 'pg';
}
