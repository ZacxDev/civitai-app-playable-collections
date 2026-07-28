import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLLECTION_STATE,
  DEFAULT_VIEW_MODE,
  isViewMode,
  loadCollectionState,
  loadViewPrefs,
  saveCollectionState,
  saveMuted,
  saveScrollSpeed,
  SCROLL_SPEED,
  VIEW_MODES,
  VIEW_PREF_KEYS,
  type CollectionState,
} from './view-modes.js';

/** Minimal in-memory Storage for the node project (no jsdom localStorage). */
function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe('view mode enum', () => {
  it('defaults to classic and lists the three modes', () => {
    expect(DEFAULT_VIEW_MODE).toBe('classic');
    expect(VIEW_MODES).toEqual(['classic', 'continuous-horizontal', 'continuous-vertical']);
  });
  it('isViewMode validates', () => {
    expect(isViewMode('classic')).toBe(true);
    expect(isViewMode('continuous-vertical')).toBe(true);
    expect(isViewMode('nope')).toBe(false);
    expect(isViewMode(42)).toBe(false);
  });
});

describe('global view prefs (mute + scroll speed)', () => {
  it('defaults: muted=true, scrollSpeed=default', () => {
    expect(loadViewPrefs(memStorage())).toEqual({ muted: true, scrollSpeed: SCROLL_SPEED.default });
  });
  it('defaults when storage is unavailable (null)', () => {
    expect(loadViewPrefs(null)).toEqual({ muted: true, scrollSpeed: SCROLL_SPEED.default });
  });
  it('round-trips muted', () => {
    const s = memStorage();
    saveMuted(false, s);
    expect(s.getItem(VIEW_PREF_KEYS.muted)).toBe('false');
    expect(loadViewPrefs(s).muted).toBe(false);
    saveMuted(true, s);
    expect(loadViewPrefs(s).muted).toBe(true);
  });
  it('clamps scroll speed on save + read', () => {
    const s = memStorage();
    expect(saveScrollSpeed(9999, s)).toBe(SCROLL_SPEED.max);
    expect(loadViewPrefs(s).scrollSpeed).toBe(SCROLL_SPEED.max);
    expect(saveScrollSpeed(1, s)).toBe(SCROLL_SPEED.min);
  });
  it('falls back to default on a corrupt muted value', () => {
    const s = memStorage({ [VIEW_PREF_KEYS.muted]: 'garbage' });
    expect(loadViewPrefs(s).muted).toBe(true);
  });
});

describe('per-collection state (mode + position)', () => {
  it('returns the default (classic, 0) when nothing is stored', () => {
    expect(loadCollectionState(101, memStorage())).toEqual(DEFAULT_COLLECTION_STATE);
  });

  it('saves + restores mode and position for a collection', () => {
    const s = memStorage();
    const state: CollectionState = { mode: 'continuous-vertical', position: 1280 };
    saveCollectionState(101, state, s);
    expect(loadCollectionState(101, s)).toEqual(state);
  });

  it('🔴 a different collection does NOT inherit another collection\'s state', () => {
    const s = memStorage();
    saveCollectionState(101, { mode: 'continuous-horizontal', position: 500 }, s);
    // 202 was never saved → its own default, not 101's.
    expect(loadCollectionState(202, s)).toEqual(DEFAULT_COLLECTION_STATE);
    // 101 still has its own.
    expect(loadCollectionState(101, s)).toEqual({ mode: 'continuous-horizontal', position: 500 });
  });

  it('degrades an unknown persisted mode to classic and a bad position to 0', () => {
    const s = memStorage({
      [VIEW_PREF_KEYS.collection(101)]: JSON.stringify({ mode: 'bogus', position: 'NaN' }),
    });
    expect(loadCollectionState(101, s)).toEqual({ mode: 'classic', position: 0 });
  });

  it('survives a corrupt JSON blob (falls back to default)', () => {
    const s = memStorage({ [VIEW_PREF_KEYS.collection(101)]: '{not json' });
    expect(loadCollectionState(101, s)).toEqual(DEFAULT_COLLECTION_STATE);
  });

  it('clamps a negative position to 0 on save', () => {
    const s = memStorage();
    saveCollectionState(101, { mode: 'classic', position: -50 }, s);
    expect(loadCollectionState(101, s).position).toBe(0);
  });

  it('uses a per-id namespaced key', () => {
    expect(VIEW_PREF_KEYS.collection(101)).toBe('playable-collections:collection:101');
    expect(VIEW_PREF_KEYS.collection(202)).toBe('playable-collections:collection:202');
  });
});
