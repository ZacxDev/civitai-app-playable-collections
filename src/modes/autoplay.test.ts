import { describe, expect, it } from 'vitest';

import { DEFAULT_AUTOPLAY_CAP, mayPlay, selectPlayable } from './autoplay.js';

describe('selectPlayable (concurrency-capped autoplay)', () => {
  it('plays every in-view video when under the cap', () => {
    const out = selectPlayable([1, 2, 3], 5);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it('🔴 caps the number simultaneously playing (the perf guard)', () => {
    const inView = [10, 11, 12, 13, 14, 15, 16, 17]; // 8 in view
    const out = selectPlayable(inView, 5);
    expect(out.size).toBe(5);
    // The first 5 by priority order win.
    expect([...out]).toEqual([10, 11, 12, 13, 14]);
    // The rest are held on their poster.
    expect(out.has(15)).toBe(false);
  });

  it('honors priority order (caller sorts the in-view list)', () => {
    const out = selectPlayable([99, 5, 42], 2);
    expect([...out]).toEqual([99, 5]);
  });

  it('dedupes repeated ids without wasting a slot', () => {
    const out = selectPlayable([1, 1, 2, 2, 3], 2);
    expect([...out]).toEqual([1, 2]);
  });

  it('plays nothing for a non-positive cap', () => {
    expect(selectPlayable([1, 2, 3], 0).size).toBe(0);
    expect(selectPlayable([1, 2, 3], -1).size).toBe(0);
  });

  it('plays nothing when nothing is in view', () => {
    expect(selectPlayable([], 5).size).toBe(0);
  });

  it('defaults the cap into the ~4-6 band', () => {
    expect(DEFAULT_AUTOPLAY_CAP).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_AUTOPLAY_CAP).toBeLessThanOrEqual(6);
    expect(selectPlayable([1, 2, 3, 4, 5, 6, 7]).size).toBe(DEFAULT_AUTOPLAY_CAP);
  });
});

describe('mayPlay', () => {
  it('is true only for ids in the playable set', () => {
    const set = selectPlayable([1, 2], 5);
    expect(mayPlay(set, 1)).toBe(true);
    expect(mayPlay(set, 9)).toBe(false);
  });
});
