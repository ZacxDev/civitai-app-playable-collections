// Pure resolution of the viewer-scoped block settings that drive playback.
//
// The manifest declares these under SNAKE_CASE keys because the platform's
// settings meta-schema (and the SDK's `defineBlock`) enforce
// `/^[a-z][a-z0-9_]{0,40}$/` on setting keys — camelCase keys are rejected.
// So the manifest keys are `seconds_per_image` / `video_loop_count`, and the
// SDK delivers them under `useBlockSettings().userSettings` keyed the same way.
// The rest of the app speaks camelCase via the resolved `PlayerSettings`.

import type { BlockSettings } from '@civitai/app-sdk/blocks';

export const SETTING_KEYS = {
  secondsPerImage: 'seconds_per_image',
  videoLoopCount: 'video_loop_count',
} as const;

export interface SettingBounds {
  default: number;
  min: number;
  max: number;
}

export const SECONDS_PER_IMAGE: SettingBounds = { default: 5, min: 1, max: 60 };
export const VIDEO_LOOP_COUNT: SettingBounds = { default: 1, min: 1, max: 10 };

export interface PlayerSettings {
  /** Seconds each image stays on screen before auto-advancing. */
  secondsPerImage: number;
  /** How many times a video loops before auto-advancing. */
  videoLoopCount: number;
}

/**
 * Coerce an unknown setting value to an integer within [min,max], falling back
 * to the default on anything invalid (NaN, non-number, out-of-range strings).
 * Values are rounded so a slider fraction never yields a fractional loop count.
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
 * Resolve the effective player settings from the host-delivered settings.
 * `viewer`-scope fields live on `userSettings`; a publisher default (should one
 * ever exist) is used only as a fallback before the hard-coded default.
 */
export function resolveSettings(settings: BlockSettings | undefined): PlayerSettings {
  const user = settings?.userSettings ?? {};
  const publisher = settings?.publisherSettings ?? {};

  const pick = (key: string) =>
    user[key] !== undefined ? user[key] : publisher[key];

  return {
    secondsPerImage: clampSetting(pick(SETTING_KEYS.secondsPerImage), SECONDS_PER_IMAGE),
    videoLoopCount: clampSetting(pick(SETTING_KEYS.videoLoopCount), VIDEO_LOOP_COUNT),
  };
}
