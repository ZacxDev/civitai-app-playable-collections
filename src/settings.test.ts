import { describe, expect, it } from 'vitest';

import {
  clampSetting,
  loadSettings,
  saveSecondsPerImage,
  saveVideoLoopCount,
  SECONDS_PER_IMAGE,
  STORAGE_KEYS,
  VIDEO_LOOP_COUNT,
} from './settings.js';

/** Minimal in-memory Storage for the node test project (no jsdom localStorage). */
function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe('clampSetting', () => {
  it('returns the default for invalid values', () => {
    expect(clampSetting(undefined, SECONDS_PER_IMAGE)).toBe(5);
    expect(clampSetting('nope', SECONDS_PER_IMAGE)).toBe(5);
    expect(clampSetting(NaN, SECONDS_PER_IMAGE)).toBe(5);
    expect(clampSetting(null, VIDEO_LOOP_COUNT)).toBe(1);
  });

  it('clamps to [min,max] and rounds', () => {
    expect(clampSetting(0, SECONDS_PER_IMAGE)).toBe(1);
    expect(clampSetting(999, SECONDS_PER_IMAGE)).toBe(60);
    expect(clampSetting(11, VIDEO_LOOP_COUNT)).toBe(10);
    expect(clampSetting(4.6, SECONDS_PER_IMAGE)).toBe(5);
  });
});

describe('loadSettings (localStorage store)', () => {
  it('returns defaults when storage is empty', () => {
    expect(loadSettings(memStorage())).toEqual({ secondsPerImage: 5, videoLoopCount: 1 });
  });

  it('returns defaults when storage is unavailable (null)', () => {
    expect(loadSettings(null)).toEqual({ secondsPerImage: 5, videoLoopCount: 1 });
  });

  it('reads persisted in-range values', () => {
    const storage = memStorage({
      [STORAGE_KEYS.secondsPerImage]: '8',
      [STORAGE_KEYS.videoLoopCount]: '3',
    });
    expect(loadSettings(storage)).toEqual({ secondsPerImage: 8, videoLoopCount: 3 });
  });

  it('clamps out-of-range persisted values to the boundary', () => {
    const storage = memStorage({
      [STORAGE_KEYS.secondsPerImage]: '1000',
      [STORAGE_KEYS.videoLoopCount]: '0',
    });
    expect(loadSettings(storage)).toEqual({ secondsPerImage: 60, videoLoopCount: 1 });
  });

  it('falls back to default on corrupt / non-numeric values', () => {
    const storage = memStorage({
      [STORAGE_KEYS.secondsPerImage]: 'garbage',
      [STORAGE_KEYS.videoLoopCount]: '',
    });
    expect(loadSettings(storage)).toEqual({ secondsPerImage: 5, videoLoopCount: 1 });
  });

  it('defaults only the missing key, keeping the other persisted', () => {
    const storage = memStorage({ [STORAGE_KEYS.videoLoopCount]: '4' });
    expect(loadSettings(storage)).toEqual({ secondsPerImage: 5, videoLoopCount: 4 });
  });
});

describe('save* persist + clamp', () => {
  it('writes secondsPerImage and reads it back', () => {
    const storage = memStorage();
    const stored = saveSecondsPerImage(12, storage);
    expect(stored).toBe(12);
    expect(storage.getItem(STORAGE_KEYS.secondsPerImage)).toBe('12');
    expect(loadSettings(storage).secondsPerImage).toBe(12);
  });

  it('clamps on write (out-of-range persisted as the boundary)', () => {
    const storage = memStorage();
    expect(saveSecondsPerImage(500, storage)).toBe(60);
    expect(storage.getItem(STORAGE_KEYS.secondsPerImage)).toBe('60');
    expect(saveVideoLoopCount(-2, storage)).toBe(1);
    expect(storage.getItem(STORAGE_KEYS.videoLoopCount)).toBe('1');
  });

  it('does not throw when storage is null', () => {
    expect(saveSecondsPerImage(7, null)).toBe(7);
    expect(saveVideoLoopCount(2, null)).toBe(2);
  });

  it('uses the namespaced localStorage keys', () => {
    expect(STORAGE_KEYS.secondsPerImage).toBe('playable-collections:secondsPerImage');
    expect(STORAGE_KEYS.videoLoopCount).toBe('playable-collections:videoLoopCount');
  });
});
