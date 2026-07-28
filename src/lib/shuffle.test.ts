import { describe, expect, it } from 'vitest';

import { hashSeedId, maybeShuffle, stableShuffle } from './shuffle.js';
import type { MediaItem } from '../types.js';

function item(mediaId: number): MediaItem {
  return { mediaId, type: 'image', url: `i/${mediaId}`, width: 1, height: 1, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}
const ids = (xs: MediaItem[]) => xs.map((x) => x.mediaId);

describe('hashSeedId', () => {
  it('is deterministic for the same (seed, id)', () => {
    expect(hashSeedId(7, 42)).toBe(hashSeedId(7, 42));
  });
  it('varies with the seed and the id', () => {
    expect(hashSeedId(1, 42)).not.toBe(hashSeedId(2, 42));
    expect(hashSeedId(7, 42)).not.toBe(hashSeedId(7, 43));
  });
  it('returns a uint32', () => {
    for (const [s, i] of [[0, 0], [123, 999], [2 ** 20, 5]] as const) {
      const h = hashSeedId(s, i);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('stableShuffle', () => {
  const all = Array.from({ length: 20 }, (_, i) => item(i + 1));

  it('is a permutation (no items lost or duplicated)', () => {
    const out = stableShuffle(all, 99);
    expect(out).toHaveLength(all.length);
    expect([...ids(out)].sort((a, b) => a - b)).toEqual(ids(all));
  });

  it('does NOT mutate the input array', () => {
    const before = ids(all);
    stableShuffle(all, 5);
    expect(ids(all)).toEqual(before);
  });

  it('actually reorders (not the identity) for a typical seed', () => {
    expect(ids(stableShuffle(all, 12345))).not.toEqual(ids(all));
  });

  it('different seeds generally give different orders', () => {
    expect(ids(stableShuffle(all, 1))).not.toEqual(ids(stableShuffle(all, 2)));
  });

  it('🔴 is STABLE across incremental page loads — arrival order does not matter', () => {
    const seed = 424242;
    const full = ids(stableShuffle(all, seed));

    // Load the same set in three arbitrary "pages" and concat in arrival order.
    const page1 = all.slice(0, 7);
    const page2 = all.slice(7, 13);
    const page3 = all.slice(13);
    const incremental = ids(stableShuffle([...page1, ...page2, ...page3], seed));
    expect(incremental).toEqual(full);

    // A DIFFERENT arrival order (pages out of order) yields the identical result.
    const reordered = ids(stableShuffle([...page3, ...page1, ...page2], seed));
    expect(reordered).toEqual(full);
  });

  it('🔴 a later page folds into the SAME slots the full shuffle would place them', () => {
    const seed = 77;
    // Re-shuffling a growing prefix: every id keeps its full-set relative order.
    const full = ids(stableShuffle(all, seed));
    const prefixOnly = ids(stableShuffle(all.slice(0, 10), seed));
    // The 10-item shuffle is exactly the full order with the absent ids removed.
    expect(full.filter((id) => id <= 10)).toEqual(prefixOnly);
  });

  it('breaks hash ties deterministically by mediaId', () => {
    const a = stableShuffle([item(3), item(1), item(2)], 9);
    const b = stableShuffle([item(2), item(3), item(1)], 9);
    expect(ids(a)).toEqual(ids(b));
  });
});

describe('maybeShuffle', () => {
  const items = [item(1), item(2), item(3)];
  it('returns the same reference when off (preserves array identity)', () => {
    expect(maybeShuffle(items, false, 1)).toBe(items);
  });
  it('returns a shuffled copy when on', () => {
    const out = maybeShuffle(items, true, 12345);
    expect(out).not.toBe(items);
    expect([...ids(out)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
