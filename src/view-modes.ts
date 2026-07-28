// View-mode types + device-local persistence for the v0.1.6 slideshow modes.
//
// Two kinds of persisted state, all localStorage (same rationale as settings.ts
// — a page app gets no host-delivered viewer settings):
//   1. GLOBAL view prefs (apply everywhere): audio mute, auto-scroll speed.
//   2. PER-COLLECTION state: the last-used view mode + scroll/playback position,
//      keyed by collection id, so reopening a collection restores where you were
//      (and a DIFFERENT collection never inherits another's mode/position).
//
// Defaults: mode = 'classic' (the existing single-item player), muted = true
// (autoplay-policy safe — the user opts into audio), filter is NOT persisted
// (it's an ephemeral per-session lens).

import { useCallback, useState } from 'react';

import { clampSetting, getLocalStorage, type SettingBounds } from './settings.js';

// ---------------------------------------------------------------------------
// View modes
// ---------------------------------------------------------------------------
export type ViewMode = 'classic' | 'continuous-horizontal' | 'continuous-vertical';

export const VIEW_MODES: readonly ViewMode[] = ['classic', 'continuous-horizontal', 'continuous-vertical'] as const;
export const DEFAULT_VIEW_MODE: ViewMode = 'classic';

export function isViewMode(v: unknown): v is ViewMode {
  return typeof v === 'string' && (VIEW_MODES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Global prefs: mute + scroll speed
// ---------------------------------------------------------------------------
/** Auto-scroll speed in px/s. Sane bounds so a drift never becomes a strobe. */
export const SCROLL_SPEED: SettingBounds = { default: 40, min: 10, max: 200 };

export const VIEW_PREF_KEYS = {
  muted: 'playable-collections:muted',
  scrollSpeed: 'playable-collections:scrollSpeed',
  /** Per-collection state key builder (mode + position). */
  collection: (id: number) => `playable-collections:collection:${id}`,
} as const;

export interface ViewPrefs {
  /** Global audio mute for videos. Starts true (autoplay-policy safe). */
  muted: boolean;
  /** Auto-scroll speed for the continuous modes (px/s, clamped). */
  scrollSpeed: number;
}

function readBool(storage: Storage | null, key: string, fallback: boolean): boolean {
  if (!storage) return fallback;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw == null) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

export function loadViewPrefs(storage: Storage | null = getLocalStorage()): ViewPrefs {
  const rawSpeed = storage ? safeGet(storage, VIEW_PREF_KEYS.scrollSpeed) : null;
  return {
    muted: readBool(storage, VIEW_PREF_KEYS.muted, true),
    scrollSpeed: rawSpeed == null ? SCROLL_SPEED.default : clampSetting(Number(rawSpeed), SCROLL_SPEED),
  };
}

export function saveMuted(value: boolean, storage: Storage | null = getLocalStorage()): boolean {
  try {
    storage?.setItem(VIEW_PREF_KEYS.muted, value ? 'true' : 'false');
  } catch {
    /* ignore */
  }
  return value;
}

export function saveScrollSpeed(value: number, storage: Storage | null = getLocalStorage()): number {
  const clamped = clampSetting(value, SCROLL_SPEED);
  try {
    storage?.setItem(VIEW_PREF_KEYS.scrollSpeed, String(clamped));
  } catch {
    /* ignore */
  }
  return clamped;
}

// ---------------------------------------------------------------------------
// Per-collection state: mode + position
// ---------------------------------------------------------------------------
export interface CollectionState {
  mode: ViewMode;
  /**
   * Restore anchor. Its meaning depends on the mode:
   *   - classic → the item index the player was on.
   *   - continuous → the scroll offset (px) of the surface.
   * A single number keeps the persisted shape tiny + forward-compatible.
   */
  position: number;
}

export const DEFAULT_COLLECTION_STATE: CollectionState = { mode: DEFAULT_VIEW_MODE, position: 0 };

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Load a collection's remembered {mode, position}. Missing/corrupt → the default
 * (classic, position 0). An unknown mode string degrades to classic; a
 * non-finite position degrades to 0. Never throws.
 */
export function loadCollectionState(id: number, storage: Storage | null = getLocalStorage()): CollectionState {
  if (!storage) return { ...DEFAULT_COLLECTION_STATE };
  const raw = safeGet(storage, VIEW_PREF_KEYS.collection(id));
  if (!raw) return { ...DEFAULT_COLLECTION_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<CollectionState>;
    const mode = isViewMode(parsed.mode) ? parsed.mode : DEFAULT_VIEW_MODE;
    const pos = typeof parsed.position === 'number' && Number.isFinite(parsed.position) ? Math.max(0, parsed.position) : 0;
    return { mode, position: pos };
  } catch {
    return { ...DEFAULT_COLLECTION_STATE };
  }
}

/** Persist a collection's {mode, position}. Silently ignores storage failures. */
export function saveCollectionState(id: number, state: CollectionState, storage: Storage | null = getLocalStorage()): void {
  const pos = Number.isFinite(state.position) ? Math.max(0, state.position) : 0;
  const clean: CollectionState = { mode: isViewMode(state.mode) ? state.mode : DEFAULT_VIEW_MODE, position: pos };
  try {
    storage?.setItem(VIEW_PREF_KEYS.collection(id), JSON.stringify(clean));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Hook: global view prefs (mute + scroll speed) with persisting setters
// ---------------------------------------------------------------------------
export function useViewPrefs(storage: Storage | null = getLocalStorage()): {
  prefs: ViewPrefs;
  setMuted: (value: boolean) => void;
  toggleMuted: () => void;
  setScrollSpeed: (value: number) => void;
} {
  const [prefs, setPrefs] = useState<ViewPrefs>(() => loadViewPrefs(storage));

  const setMuted = useCallback(
    (value: boolean) => {
      saveMuted(value, storage);
      setPrefs((p) => ({ ...p, muted: value }));
    },
    [storage],
  );
  const toggleMuted = useCallback(() => {
    setPrefs((p) => {
      const next = !p.muted;
      saveMuted(next, storage);
      return { ...p, muted: next };
    });
  }, [storage]);
  const setScrollSpeed = useCallback(
    (value: number) => {
      const clamped = saveScrollSpeed(value, storage);
      setPrefs((p) => ({ ...p, scrollSpeed: clamped }));
    },
    [storage],
  );

  return { prefs, setMuted, toggleMuted, setScrollSpeed };
}
