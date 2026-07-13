// Player playback preferences.
//
// These two prefs used to be manifest `viewer`-scope settings delivered by the
// host via `useBlockSettings()`. That path is dead for a PAGE app: the block
// token mint 403s when the manifest declares `block:settings:*` (the mint's C8
// gate requires the caller to be the block *installer*, and a page app has no
// installer), AND per-viewer manifest settings are unbuilt platform-wide (both
// hosts ship `userSettings: {}`). So these are ephemeral, DEVICE-LOCAL UI prefs
// persisted in localStorage — no scopes, no host round-trip. The durable
// "settings-on-pages" platform capability is filed separately.

import { useCallback, useState } from 'react';

export interface SettingBounds {
  default: number;
  min: number;
  max: number;
}

export const SECONDS_PER_IMAGE: SettingBounds = { default: 5, min: 1, max: 60 };
export const VIDEO_LOOP_COUNT: SettingBounds = { default: 1, min: 1, max: 10 };

/** localStorage keys (namespaced to the app). */
export const STORAGE_KEYS = {
  secondsPerImage: 'playable-collections:secondsPerImage',
  videoLoopCount: 'playable-collections:videoLoopCount',
} as const;

export interface PlayerSettings {
  /** Seconds each image stays on screen before auto-advancing. */
  secondsPerImage: number;
  /** How many times a video loops before auto-advancing. */
  videoLoopCount: number;
}

/**
 * Coerce an unknown value to an integer within [min,max], falling back to the
 * default on anything invalid (NaN, non-number). In-range values pass through;
 * OUT-of-range values are clamped to the boundary. Rounded so a slider fraction
 * never yields a fractional loop count.
 */
export function clampSetting(value: unknown, bounds: SettingBounds): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return bounds.default;
  const rounded = Math.round(n);
  if (rounded < bounds.min) return bounds.min;
  if (rounded > bounds.max) return bounds.max;
  return rounded;
}

/**
 * Best-effort localStorage handle. Returns `null` when storage is unavailable
 * (SSR, privacy mode, disabled) so callers fall back to defaults without
 * throwing.
 */
export function getLocalStorage(): Storage | null {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/** Read + clamp one persisted pref. Missing OR non-numeric -> default. */
function readOne(storage: Storage | null, key: string, bounds: SettingBounds): number {
  if (!storage) return bounds.default;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return bounds.default;
  }
  if (raw == null) return bounds.default;
  const n = Number(raw);
  if (!Number.isFinite(n)) return bounds.default; // corrupt / non-numeric
  return clampSetting(n, bounds); // in-range passes; out-of-range clamps
}

/** Load both prefs from storage (defaults when empty/corrupt). */
export function loadSettings(storage: Storage | null = getLocalStorage()): PlayerSettings {
  return {
    secondsPerImage: readOne(storage, STORAGE_KEYS.secondsPerImage, SECONDS_PER_IMAGE),
    videoLoopCount: readOne(storage, STORAGE_KEYS.videoLoopCount, VIDEO_LOOP_COUNT),
  };
}

/** Persist secondsPerImage (clamped). Silently ignores storage failures. Returns the stored value. */
export function saveSecondsPerImage(value: number, storage: Storage | null = getLocalStorage()): number {
  const clamped = clampSetting(value, SECONDS_PER_IMAGE);
  try {
    storage?.setItem(STORAGE_KEYS.secondsPerImage, String(clamped));
  } catch {
    /* ignore */
  }
  return clamped;
}

/** Persist videoLoopCount (clamped). Silently ignores storage failures. Returns the stored value. */
export function saveVideoLoopCount(value: number, storage: Storage | null = getLocalStorage()): number {
  const clamped = clampSetting(value, VIDEO_LOOP_COUNT);
  try {
    storage?.setItem(STORAGE_KEYS.videoLoopCount, String(clamped));
  } catch {
    /* ignore */
  }
  return clamped;
}

/**
 * React hook exposing the device-local player settings + persisting setters.
 * Reads localStorage once on mount; each setter clamps, persists, and updates
 * state so the player (which consumes `PlayerSettings`) picks up changes live.
 */
export function usePlayerSettings(storage: Storage | null = getLocalStorage()): {
  settings: PlayerSettings;
  setSecondsPerImage: (value: number) => void;
  setVideoLoopCount: (value: number) => void;
} {
  const [settings, setSettings] = useState<PlayerSettings>(() => loadSettings(storage));

  const setSecondsPerImage = useCallback(
    (value: number) => {
      const clamped = saveSecondsPerImage(value, storage);
      setSettings((s) => ({ ...s, secondsPerImage: clamped }));
    },
    [storage],
  );

  const setVideoLoopCount = useCallback(
    (value: number) => {
      const clamped = saveVideoLoopCount(value, storage);
      setSettings((s) => ({ ...s, videoLoopCount: clamped }));
    },
    [storage],
  );

  return { settings, setSecondsPerImage, setVideoLoopCount };
}
