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

export type MaturityBucket = 'pg' | 'pg13' | 'r' | 'x' | 'xxx';

const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const XXX = 16;

/** Bucket a raw `nsfwLevel` bitmask into its highest maturity tier. */
export function maturityBucket(nsfwLevel: number): MaturityBucket {
  const n = Number.isFinite(nsfwLevel) ? nsfwLevel : PG;
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
};

/** Human rating label for the badge (e.g. `R`, `XXX`). */
export function maturityLabel(nsfwLevel: number): string {
  return LABELS[maturityBucket(nsfwLevel)];
}

/**
 * Whether an item should be BLURRED until the viewer taps to reveal. True for
 * anything above PG-13 (R and up), since the app's declared rating is pg13.
 */
export function shouldBlur(nsfwLevel: number): boolean {
  const b = maturityBucket(nsfwLevel);
  return b === 'r' || b === 'x' || b === 'xxx';
}

/** Whether a maturity badge is worth showing at all (anything above PG). */
export function hasMaturityBadge(nsfwLevel: number): boolean {
  return maturityBucket(nsfwLevel) !== 'pg';
}
