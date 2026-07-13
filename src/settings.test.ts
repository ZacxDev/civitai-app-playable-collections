import { describe, expect, it } from 'vitest';

import type { BlockSettings } from '@civitai/app-sdk/blocks';
import {
  clampSetting,
  resolveSettings,
  SECONDS_PER_IMAGE,
  SETTING_KEYS,
  VIDEO_LOOP_COUNT,
} from './settings.js';

function settings(user: Record<string, unknown>, publisher: Record<string, unknown> = {}): BlockSettings {
  return { userSettings: user, publisherSettings: publisher };
}

describe('clampSetting', () => {
  it('returns the default for invalid values', () => {
    expect(clampSetting(undefined, SECONDS_PER_IMAGE)).toBe(5);
    expect(clampSetting('nope', SECONDS_PER_IMAGE)).toBe(5);
    expect(clampSetting(NaN, SECONDS_PER_IMAGE)).toBe(5);
    expect(clampSetting(null, VIDEO_LOOP_COUNT)).toBe(1);
  });

  it('clamps to [min,max]', () => {
    expect(clampSetting(0, SECONDS_PER_IMAGE)).toBe(1); // below min
    expect(clampSetting(999, SECONDS_PER_IMAGE)).toBe(60); // above max
    expect(clampSetting(11, VIDEO_LOOP_COUNT)).toBe(10);
    expect(clampSetting(-3, VIDEO_LOOP_COUNT)).toBe(1);
  });

  it('rounds fractional values', () => {
    expect(clampSetting(4.6, SECONDS_PER_IMAGE)).toBe(5);
    expect(clampSetting('7.2', SECONDS_PER_IMAGE)).toBe(7);
  });
});

describe('resolveSettings', () => {
  it('reads the snake_case viewer keys the manifest declares', () => {
    const resolved = resolveSettings(
      settings({
        [SETTING_KEYS.secondsPerImage]: 8,
        [SETTING_KEYS.videoLoopCount]: 3,
      }),
    );
    expect(resolved).toEqual({ secondsPerImage: 8, videoLoopCount: 3 });
  });

  it('falls back to defaults when unset', () => {
    expect(resolveSettings(settings({}))).toEqual({ secondsPerImage: 5, videoLoopCount: 1 });
    expect(resolveSettings(undefined)).toEqual({ secondsPerImage: 5, videoLoopCount: 1 });
  });

  it('clamps out-of-range viewer values', () => {
    const resolved = resolveSettings(
      settings({ [SETTING_KEYS.secondsPerImage]: 1000, [SETTING_KEYS.videoLoopCount]: 0 }),
    );
    expect(resolved).toEqual({ secondsPerImage: 60, videoLoopCount: 1 });
  });

  it('uses a publisher default only when the viewer value is absent', () => {
    const resolved = resolveSettings(
      settings({}, { [SETTING_KEYS.secondsPerImage]: 12 }),
    );
    expect(resolved.secondsPerImage).toBe(12);
  });

  it('manifest keys are snake_case (SDK key pattern requires it)', () => {
    expect(SETTING_KEYS.secondsPerImage).toBe('seconds_per_image');
    expect(SETTING_KEYS.videoLoopCount).toBe('video_loop_count');
  });
});
