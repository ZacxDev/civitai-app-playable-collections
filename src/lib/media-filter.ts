// Client-side media-type filter (All / Images / Videos) over the LOADED items.
//
// The interaction that matters (and is unit-tested): filtering only sees what's
// already loaded, so a filter can empty the visible set even though matching
// items exist on later, not-yet-fetched pages. `needsMoreToFill` tells the
// caller when to keep pulling pages (bounded by the loader's own page ceiling)
// so a filter that excludes the whole first page still surfaces later matches.

import type { MediaItem } from '../types.js';

export type MediaFilter = 'all' | 'images' | 'videos';

export const MEDIA_FILTERS: readonly MediaFilter[] = ['all', 'images', 'videos'] as const;

/** Number of matching items we try to have on screen before we stop auto-paging to fill. */
export const FILL_TARGET = 12;

/** Filter `items` by media type. `all` returns the input unchanged (same reference). */
export function filterByType(items: MediaItem[], filter: MediaFilter): MediaItem[] {
  if (filter === 'all') return items;
  const want: MediaItem['type'] = filter === 'images' ? 'image' : 'video';
  return items.filter((it) => it.type === want);
}

/**
 * Should the caller fetch another page to fill the filtered view? True when a
 * non-`all` filter is active, more pages exist, none is already in flight, and
 * fewer than `target` matches are currently visible. Bounded externally by the
 * loader's MAX_DETAIL_PAGES — this only decides "keep asking", the loader
 * decides "no more pages".
 */
export function needsMoreToFill(
  filter: MediaFilter,
  filteredCount: number,
  hasMore: boolean,
  loadingMore: boolean,
  target: number = FILL_TARGET,
): boolean {
  if (filter === 'all') return false;
  if (!hasMore || loadingMore) return false;
  return filteredCount < target;
}
