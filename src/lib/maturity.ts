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
// that decision, never to re-ask it AND NEVER TO OVERRIDE IT: an item the ceiling
// excludes is not shown at all, an item the ceiling permits IS shown, and there is
// no affordance anywhere that reveals or conceals one.
//
// 🔴 "NEVER TO OVERRIDE IT" IS NOT DECORATION — being STRICTER than the server is
// the same defect wearing safety colours. This file's first attempt hid every
// unrated (`nsfwLevel === 0`) item, which the server permits at every ceiling; that
// is worse than the blur it replaced, because a blurred item was still reachable.
// `withinCeiling` below therefore mirrors the server's SQL exactly, with the
// citation, and diverges only for wire values the server can never receive.
//
// Civitai `nsfwLevel` is a power-of-two tier (PG=1, PG-13=2, R=4, X=8, XXX=16);
// values can be OR'd, so the badge buckets by the HIGHEST tier present. Pure +
// tested.

import { SFW_LEVELS } from '@civitai/app-sdk/blocks';

export type MaturityBucket = 'pg' | 'pg13' | 'r' | 'x' | 'xxx' | 'unknown';

const PG13 = 2;
const R = 4;
const X = 8;
const XXX = 16;

/**
 * Is an item at `nsfwLevel` permitted by the platform's `ceiling` bitmask?
 * This is the ONE predicate the whole app renders from.
 *
 * 🔴 IT MIRRORS THE SERVER'S RULE, BECAUSE OVERRIDING THE SERVER IS THE EXACT
 * BEHAVIOUR THIS FILE EXISTS TO REMOVE. Measured on `origin/release` in
 * <civitai> `src/server/services/blocks/block-collections.service.ts`:
 *
 *     // the cover clamp (getFallbackCoverImages, ~line 193)
 *     AND ((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)
 *
 *     // the playable sample (~line 334) — the same test
 *     OR (i."nsfwLevel" & ${browsingLevel}) != 0
 *     OR i."nsfwLevel" = 0
 *
 *     // and its own TypeScript predicate, collectionWithinCeiling (~line 359)
 *     if (!nsfwLevel) return true;
 *     return Flags.intersects(nsfwLevel, browsingLevel);
 *
 * Two consequences, both of which an earlier revision of this function got wrong:
 *
 *   1. AN EXPLICIT UNRATED `0` IS PERMITTED, AT EVERY CEILING INCLUDING SFW. The
 *      server has made a decision about it; hiding it would be the app
 *      second-guessing that decision, and it is strictly worse than the blur it
 *      replaced — a blurred item was at least reachable, a hidden one is gone.
 *      `toCoverFields` publishes an unrated cover as the value `0` (~line 150),
 *      so this is a real, common wire value, not an edge case.
 *   2. THE TEST IS INTERSECTION, NOT CONTAINMENT. A MIXED bucket (e.g. 29) shares
 *      a bit with a SFW ceiling and the server keeps it; a containment test would
 *      drop it. That is why this does NOT use the SDK's `isLevelAllowed`, which is
 *      containment by design — it answers "may I offer an R-rated AFFORDANCE?"
 *      for one level bit, a different question from "may this ITEM be shown?".
 *      The two agree on every single-bit level and diverge only on OR'd values.
 *
 * 🔴 STILL FAILS CLOSED ON GENUINELY UNKNOWABLE INPUT, AND THAT IS A DIFFERENT
 * CASE FROM AN EXPLICIT `0` — conflating them is what produced the bug above.
 *   - `undefined` / `null` / `NaN` / non-finite / negative → NOT permitted. An
 *     absent value is US NOT KNOWING; `0` is a rating the server assigned. The
 *     only field that can be absent is `CollectionSummary.coverNsfwLevel`, and per
 *     civitai #4663 it is absent exactly when there is NO COVER (`toCoverFields`
 *     omits it when `coverImageUrl === null`) — never for an unrated cover.
 *   - an ABSENT CEILING (before `BLOCK_INIT`, or a host predating civitai #2670)
 *     falls back to `SFW_LEVELS`, the SDK's own fail-closed default, so the
 *     constant stays single-sourced from the platform.
 *
 * 🔴 NOTE THE DELIBERATE DIVERGENCE FROM THE SERVER'S `if (!nsfwLevel)`. That is
 * TRUTHINESS, so it would also permit `undefined` and `NaN`. It is correct there —
 * the argument is a non-null database column — and wrong here, where the value
 * arrives over the wire from a host that may predate the field. Identical for
 * every value the server can produce; tighter only for inputs it never has.
 */
export function withinCeiling(
  nsfwLevel: number | undefined | null,
  ceiling: number | undefined,
): nsfwLevel is number {
  // UNKNOWABLE first — this ordering is the whole guard. Written the server's way
  // (`if (!nsfwLevel) return true`) an absent level would be permitted.
  if (typeof nsfwLevel !== 'number' || !Number.isFinite(nsfwLevel) || nsfwLevel < 0) return false;
  // An explicit unrated level. The server permits it on every ceiling; so do we.
  if (nsfwLevel === 0) return true;
  const mask = typeof ceiling === 'number' && Number.isFinite(ceiling) ? ceiling : SFW_LEVELS;
  return (nsfwLevel & mask) !== 0;
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
  // 🔴 `unknown` IS A LIVE, REACHABLE BUCKET. An unrated `0` is PERMITTED (see
  // `withinCeiling`), so it renders — and it renders badged "Unrated", which is
  // the honest label for a level the server assigned no tier to. Malformed input
  // maps here too, but never reaches a badge, because it is never permitted.
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
