// Seeded, STABLE shuffle for a collection's media.
//
// The v0.1.6 "shuffle collection" power-feature must be deterministic AND stable
// across lazy paging: the media arrive one page at a time, so the shuffled order
// cannot depend on arrival order — otherwise a page that streams in later would
// reshuffle what's already on screen non-deterministically.
//
// The trick: order is a PURE function of `(seed, mediaId)` via a hash. Sorting
// any subset (or the whole set, in any arrival order) by that hash yields the
// same relative order every time. So:
//   stableShuffle(page1 ++ page2, seed) === stableShuffle(allItems, seed)
// regardless of how the pages were concatenated. New pages simply "fold in" to
// their hash-determined slots.

import type { MediaItem } from '../types.js';

/**
 * Deterministic 32-bit hash of `(seed, id)`. Uses a couple of xorshift/multiply
 * rounds (the finalizer from the MurmurHash3 family) so nearby ids scatter well
 * — a plain `seed*id` would cluster. Pure; same inputs → same output.
 */
export function hashSeedId(seed: number, id: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (id + 0x85ebca6b), 0xcc9e2d51) >>> 0;
  h = ((h << 15) | (h >>> 17)) >>> 0;
  h = Math.imul(h, 0x1b873593) >>> 0;
  h ^= id;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Return a new array of `items` ordered by `hashSeedId(seed, mediaId)`. STABLE
 * across incremental page loads: the order depends only on the seed + each
 * item's mediaId, never on the input order or how many pages have loaded.
 * `mediaId` breaks hash ties so the result is fully deterministic.
 */
export function stableShuffle<T extends { mediaId: number }>(items: readonly T[], seed: number): T[] {
  return [...items].sort((a, b) => {
    const ha = hashSeedId(seed, a.mediaId);
    const hb = hashSeedId(seed, b.mediaId);
    if (ha !== hb) return ha - hb;
    return a.mediaId - b.mediaId;
  });
}

/**
 * Apply `stableShuffle` only when `on` — otherwise return the input as-is (same
 * reference), so the no-shuffle path preserves array identity (which the classic
 * player's append-detection relies on to keep the playback cursor).
 */
export function maybeShuffle(items: MediaItem[], on: boolean, seed: number): MediaItem[] {
  return on ? stableShuffle(items, seed) : items;
}
