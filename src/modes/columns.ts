// Pure responsive-column + balanced-masonry layout for the continuous-vertical
// "wall" mode. Mobile-first: the column count DEGRADES from 3 → 2 → 1 as the
// available width narrows (the app is mobile-first — it is NOT fixed at 3).

import type { MediaItem } from '../types.js';

/** Width breakpoints (px) → column count. Mobile-first, degrades gracefully. */
export const WALL_BREAKPOINTS = { two: 520, three: 900 } as const;

/**
 * Column count for the vertical wall at a given content width.
 *   width <  520 → 1 (phone)
 *   width <  900 → 2 (large phone / tablet)
 *   width >= 900 → 3 (desktop)
 * A non-positive/unknown width falls back to 1 (safest for the smallest view).
 */
export function columnCount(width: number): number {
  if (!(width > 0)) return 1;
  if (width < WALL_BREAKPOINTS.two) return 1;
  if (width < WALL_BREAKPOINTS.three) return 2;
  return 3;
}

/** The height weight one item contributes to its column (aspect ratio; taller
 * media = more weight). Guards divide-by-zero on missing dimensions. */
export function itemHeightWeight(item: Pick<MediaItem, 'width' | 'height'>): number {
  if (item.width > 0 && item.height > 0) return item.height / item.width;
  return 1;
}

/**
 * Balanced masonry: greedily place each item into the currently-SHORTEST column
 * (by accumulated aspect-ratio height), preserving input order within a column.
 * Deterministic and pure → unit-testable without layout. Returns `cols` arrays
 * (some may be empty when there are fewer items than columns).
 */
export function assignColumns<T extends Pick<MediaItem, 'width' | 'height'>>(
  items: readonly T[],
  cols: number,
): T[][] {
  const n = Math.max(1, Math.floor(cols));
  const columns: T[][] = Array.from({ length: n }, () => []);
  const heights = new Array(n).fill(0);
  for (const item of items) {
    // shortest column (first one on a tie → stable left-to-right fill)
    let target = 0;
    for (let k = 1; k < n; k += 1) {
      if (heights[k] < heights[target]) target = k;
    }
    columns[target].push(item);
    heights[target] += itemHeightWeight(item);
  }
  return columns;
}
