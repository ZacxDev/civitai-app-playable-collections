import { describe, expect, it } from 'vitest';

import type { MediaItem } from '../types.js';
import {
  atEnd,
  atStart,
  createPlaylist,
  currentItem,
  goTo,
  goToItemIndex,
  next,
  peekNext,
  prev,
  progressLabel,
  shuffleIndices,
  toggleShuffle,
} from './engine.js';

function items(n: number): MediaItem[] {
  return Array.from({ length: n }, (_, i) => ({
    mediaId: i + 1,
    type: i % 2 === 0 ? 'image' : 'video',
    url: `u/${i + 1}`,
    width: 100,
    height: 100,
    creator: { userId: 1, username: 'a' },
    nsfwLevel: 1,
  }));
}

/** Deterministic RNG that always picks the last element in Fisher-Yates (reverse). */
const reverseRng = () => 0.999999;

describe('createPlaylist / currentItem', () => {
  it('starts at the first item in natural order', () => {
    const s = createPlaylist(items(3));
    expect(currentItem(s)?.mediaId).toBe(1);
    expect(s.order).toEqual([0, 1, 2]);
    expect(s.shuffled).toBe(false);
  });

  it('returns null for an empty playlist', () => {
    const s = createPlaylist([]);
    expect(currentItem(s)).toBeNull();
    expect(peekNext(s)).toBeNull();
    expect(progressLabel(s)).toBe('0 / 0');
  });
});

describe('next / prev with wrap', () => {
  it('advances and wraps to the start past the end', () => {
    let s = createPlaylist(items(3));
    s = next(s);
    expect(currentItem(s)?.mediaId).toBe(2);
    s = next(s);
    expect(currentItem(s)?.mediaId).toBe(3);
    expect(atEnd(s)).toBe(true);
    s = next(s); // wrap
    expect(currentItem(s)?.mediaId).toBe(1);
    expect(atStart(s)).toBe(true);
  });

  it('goes back and wraps to the end before the start', () => {
    let s = createPlaylist(items(3));
    s = prev(s); // wrap to last
    expect(currentItem(s)?.mediaId).toBe(3);
    s = prev(s);
    expect(currentItem(s)?.mediaId).toBe(2);
  });

  it('does not wrap when wrap=false', () => {
    let s = createPlaylist(items(2));
    s = next(s, false); // at index 1 (end)
    expect(currentItem(s)?.mediaId).toBe(2);
    s = next(s, false); // stays
    expect(currentItem(s)?.mediaId).toBe(2);
    s = createPlaylist(items(2));
    s = prev(s, false); // stays at start
    expect(currentItem(s)?.mediaId).toBe(1);
  });
});

describe('peekNext (preload)', () => {
  it('returns the upcoming item, honoring wrap', () => {
    const s = createPlaylist(items(2));
    expect(peekNext(s)?.mediaId).toBe(2);
    const end = next(s);
    expect(peekNext(end)?.mediaId).toBe(1); // wraps
    expect(peekNext(end, false)).toBeNull();
  });
});

describe('shuffleIndices', () => {
  it('returns a permutation of [0..n)', () => {
    const out = shuffleIndices(6, () => 0.5);
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('is deterministic given a fixed RNG', () => {
    const a = shuffleIndices(5, reverseRng);
    const b = shuffleIndices(5, reverseRng);
    expect(a).toEqual(b);
  });
});

describe('toggleShuffle', () => {
  it('keeps the current item on screen when enabling shuffle', () => {
    let s = createPlaylist(items(5));
    s = next(s);
    s = next(s); // showing mediaId 3 (natural index 2)
    const before = currentItem(s)?.mediaId;
    s = toggleShuffle(s, reverseRng);
    expect(s.shuffled).toBe(true);
    expect(s.position).toBe(0);
    expect(currentItem(s)?.mediaId).toBe(before); // same item still showing
    // and it's a full permutation
    expect([...s.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('restores natural order and keeps the current item when disabling', () => {
    let s = createPlaylist(items(4), { shuffle: true, rng: reverseRng });
    const showing = currentItem(s)?.mediaId;
    s = toggleShuffle(s, reverseRng); // -> natural
    expect(s.shuffled).toBe(false);
    expect(s.order).toEqual([0, 1, 2, 3]);
    expect(currentItem(s)?.mediaId).toBe(showing);
  });
});

describe('goTo / goToItemIndex', () => {
  it('clamps goTo within range', () => {
    const s = createPlaylist(items(3));
    expect(goTo(s, 99).position).toBe(2);
    expect(goTo(s, -5).position).toBe(0);
  });

  it('goToItemIndex jumps to the position of a natural index in the order', () => {
    const s = createPlaylist(items(4), { shuffle: true, rng: reverseRng });
    const jumped = goToItemIndex(s, 2); // natural item index 2 (mediaId 3)
    expect(currentItem(jumped)?.mediaId).toBe(3);
  });
});

describe('progressLabel', () => {
  it('is 1-based over the order length', () => {
    let s = createPlaylist(items(3));
    expect(progressLabel(s)).toBe('1 / 3');
    s = next(s);
    expect(progressLabel(s)).toBe('2 / 3');
  });
});
