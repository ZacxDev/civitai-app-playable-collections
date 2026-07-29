// Content-maturity mapping for a media item's Civitai `nsfwLevel`.
//
// `nsfwLevel` is carried on every MediaItem but was previously UNUSED in the UI.
// This app is rated `pg13` and served on a PUBLIC subdomain, so we do NOT assume
// the block media API clamps reads by the viewer's browsing level (no evidence
// it does). The safe default: label each item with a maturity badge and
// BLUR-UNTIL-TAP anything above PG-13, so mature media never renders unguarded.
//
// Civitai `nsfwLevel` is a power-of-two tier (PG=1, PG-13=2, R=4, X=8, XXX=16);
// values can be OR'd, so we bucket by the HIGHEST tier present. Pure + tested.
//
// 🔴 FAILS CLOSED: a missing / 0 / non-finite level is `'unknown'` and treated
// as mature (blurred + badged). On a pg13 public app the safe default when we
// can't confirm a rating is to gate it, not to show it full-strength.

export type MaturityBucket = 'pg' | 'pg13' | 'r' | 'x' | 'xxx' | 'unknown';

const PG13 = 2;
const R = 4;
const X = 8;
const XXX = 16;

/** Bucket a raw `nsfwLevel` bitmask into its highest maturity tier (unknown fails closed). */
export function maturityBucket(nsfwLevel: number): MaturityBucket {
  // Unknown / unrated / malformed → treat as mature (fail closed).
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
  unknown: 'NSFW',
};

/** Human rating label for the badge (e.g. `R`, `XXX`, `NSFW` for unknown). */
export function maturityLabel(nsfwLevel: number): string {
  return LABELS[maturityBucket(nsfwLevel)];
}

/**
 * Whether an item should be BLURRED until the viewer taps to reveal. True for
 * anything above PG-13 (R and up) AND for an unknown/unrated level (fail closed),
 * since the app's declared rating is pg13.
 */
export function shouldBlur(nsfwLevel: number): boolean {
  const b = maturityBucket(nsfwLevel);
  return b === 'r' || b === 'x' || b === 'xxx' || b === 'unknown';
}

/** Whether a maturity badge is worth showing at all (anything above PG, incl. unknown). */
export function hasMaturityBadge(nsfwLevel: number): boolean {
  return maturityBucket(nsfwLevel) !== 'pg';
}
