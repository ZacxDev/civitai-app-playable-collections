// Pure playlist state machine for the media player. No React, no DOM, no timers
// — all timing/element concerns live in ../player/usePlayer.ts. Keeping the
// transition logic pure means next/prev/wrap/shuffle are exhaustively unit
// tested in node without a renderer.

import type { MediaItem } from '../types.js';

/** Injectable RNG so shuffle is deterministic in tests. Returns [0,1). */
export type Rng = () => number;

export interface PlaylistState {
  /** The items, in their original (server) order. Never reordered in place. */
  readonly items: readonly MediaItem[];
  /**
   * Playback order: an index permutation into `items`. Natural order is
   * [0,1,2,…]; a shuffled order is a permutation of it.
   */
  readonly order: readonly number[];
  /** Position within `order` (NOT within `items`). */
  readonly position: number;
  readonly shuffled: boolean;
}

/** Fisher-Yates shuffle of [0..n), using an injectable RNG. Pure. */
export function shuffleIndices(n: number, rng: Rng = Math.random): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Build a playlist. When `shuffle` is true the order is randomized but the item
 * that would be first in natural order is NOT special-cased — a fresh shuffled
 * playlist starts at `order[0]`.
 */
export function createPlaylist(
  items: readonly MediaItem[],
  opts: { shuffle?: boolean; rng?: Rng } = {},
): PlaylistState {
  const order = opts.shuffle ? shuffleIndices(items.length, opts.rng) : items.map((_, i) => i);
  return { items, order, position: 0, shuffled: Boolean(opts.shuffle) };
}

/** The currently-showing item, or null for an empty playlist. */
export function currentItem(state: PlaylistState): MediaItem | null {
  if (state.items.length === 0) return null;
  const idx = state.order[state.position];
  return state.items[idx] ?? null;
}

/** The item that would show next (for preloading), or null. Honors wrap. */
export function peekNext(state: PlaylistState, wrap = true): MediaItem | null {
  if (state.items.length === 0) return null;
  let pos = state.position + 1;
  if (pos >= state.order.length) {
    if (!wrap) return null;
    pos = 0;
  }
  return state.items[state.order[pos]] ?? null;
}

export function atStart(state: PlaylistState): boolean {
  return state.position === 0;
}

export function atEnd(state: PlaylistState): boolean {
  return state.position >= state.order.length - 1;
}

/** Advance one item. Wraps to the start past the end unless `wrap` is false. */
export function next(state: PlaylistState, wrap = true): PlaylistState {
  if (state.order.length === 0) return state;
  let pos = state.position + 1;
  if (pos >= state.order.length) {
    if (!wrap) return state;
    pos = 0;
  }
  return { ...state, position: pos };
}

/** Go back one item. Wraps to the end before the start unless `wrap` is false. */
export function prev(state: PlaylistState, wrap = true): PlaylistState {
  if (state.order.length === 0) return state;
  let pos = state.position - 1;
  if (pos < 0) {
    if (!wrap) return state;
    pos = state.order.length - 1;
  }
  return { ...state, position: pos };
}

/** Jump to a specific position within `order` (clamped). */
export function goTo(state: PlaylistState, position: number): PlaylistState {
  if (state.order.length === 0) return state;
  const clamped = Math.max(0, Math.min(position, state.order.length - 1));
  return { ...state, position: clamped };
}

/**
 * Jump to the item whose ORIGINAL index within `items` matches the given item's
 * position in `order`. Used by a scrubber that thinks in natural item indices.
 */
export function goToItemIndex(state: PlaylistState, itemIndex: number): PlaylistState {
  const pos = state.order.indexOf(itemIndex);
  return pos === -1 ? state : { ...state, position: pos };
}

/**
 * Toggle shuffle while KEEPING the current item on screen.
 *  - enabling: build a shuffled order, then move the current item to the front
 *    (position 0) so playback continues from where the user is.
 *  - disabling: restore natural order and set position to the current item's
 *    natural index.
 */
export function toggleShuffle(state: PlaylistState, rng: Rng = Math.random): PlaylistState {
  const currentNaturalIndex = state.order[state.position] ?? 0;
  if (state.shuffled) {
    // -> natural order
    return {
      ...state,
      order: state.items.map((_, i) => i),
      position: currentNaturalIndex,
      shuffled: false,
    };
  }
  // -> shuffled order, current item first
  const shuffled = shuffleIndices(state.items.length, rng);
  const at = shuffled.indexOf(currentNaturalIndex);
  if (at > 0) {
    shuffled.splice(at, 1);
    shuffled.unshift(currentNaturalIndex);
  }
  return { ...state, order: shuffled, position: 0, shuffled: true };
}

/** Human-friendly "3 / 12" progress for the current position. */
export function progressLabel(state: PlaylistState): string {
  if (state.order.length === 0) return '0 / 0';
  return `${state.position + 1} / ${state.order.length}`;
}
