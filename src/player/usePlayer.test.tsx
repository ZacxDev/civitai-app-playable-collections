import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaItem } from '../types.js';
import { usePlayer } from './usePlayer.js';

function img(id: number): MediaItem {
  return { mediaId: id, type: 'image', url: `i/${id}`, width: 1, height: 1, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}
function vid(id: number): MediaItem {
  return { mediaId: id, type: 'video', url: `v/${id}`, width: 1, height: 1, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}

/** Deterministic RNG for shuffle. */
const rng = () => 0.42;

describe('usePlayer — image auto-advance timing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('advances an image after secondsPerImage seconds when playing', () => {
    const items = [img(1), img(2), img(3)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 3, videoLoopCount: 1, autoPlay: true, rng }),
    );
    expect(result.current.current?.mediaId).toBe(1);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.current?.mediaId).toBe(2);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.current?.mediaId).toBe(3);
  });

  it('does NOT advance while paused', () => {
    const items = [img(1), img(2)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 2, videoLoopCount: 1, autoPlay: false, rng }),
    );
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(result.current.current?.mediaId).toBe(1); // still paused

    act(() => result.current.play());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.current?.mediaId).toBe(2);
  });

  it('secondsPerImage drives the interval (setting application)', () => {
    const items = [img(1), img(2)];
    // 5s setting: not advanced at 2s, advanced at 5s.
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 5, videoLoopCount: 1, autoPlay: true, rng }),
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.current?.mediaId).toBe(1);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.current?.mediaId).toBe(2);
  });
});

describe('usePlayer — video loop-then-advance', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('replays until videoLoopCount, then advances', () => {
    const items = [vid(1), img(2)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 5, videoLoopCount: 3, autoPlay: true, rng }),
    );
    expect(result.current.current?.mediaId).toBe(1);

    let outcome = '';
    act(() => {
      outcome = result.current.onVideoEnded();
    });
    expect(outcome).toBe('replay');
    expect(result.current.videoLoop).toBe(1);
    expect(result.current.current?.mediaId).toBe(1);

    act(() => {
      outcome = result.current.onVideoEnded();
    });
    expect(outcome).toBe('replay');
    expect(result.current.current?.mediaId).toBe(1);

    act(() => {
      outcome = result.current.onVideoEnded();
    });
    expect(outcome).toBe('advance');
    expect(result.current.current?.mediaId).toBe(2);
  });

  it('videoLoopCount=1 advances on the first end', () => {
    const items = [vid(1), img(2)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 5, videoLoopCount: 1, autoPlay: true, rng }),
    );
    act(() => {
      result.current.onVideoEnded();
    });
    expect(result.current.current?.mediaId).toBe(2);
  });

  it('does not auto-advance a video via the image timer', () => {
    const items = [vid(1), img(2)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 1, videoLoopCount: 2, autoPlay: true, rng }),
    );
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current.current?.mediaId).toBe(1); // still on the video
  });
});

describe('usePlayer — transport controls', () => {
  it('next / prev wrap around the ends', () => {
    const items = [img(1), img(2), img(3)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 99, videoLoopCount: 1, autoPlay: false, rng }),
    );
    act(() => result.current.next());
    expect(result.current.current?.mediaId).toBe(2);
    act(() => result.current.prev());
    act(() => result.current.prev()); // wrap to end
    expect(result.current.current?.mediaId).toBe(3);
  });

  it('toggleShuffle keeps the current item and flips shuffled', () => {
    const items = [img(1), img(2), img(3), img(4)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 99, videoLoopCount: 1, autoPlay: false, rng }),
    );
    act(() => result.current.next()); // showing mediaId 2
    const before = result.current.current?.mediaId;
    act(() => result.current.toggleShuffle());
    expect(result.current.state.shuffled).toBe(true);
    expect(result.current.current?.mediaId).toBe(before);
  });

  it('seekToPosition jumps within the order', () => {
    const items = [img(1), img(2), img(3)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 99, videoLoopCount: 1, autoPlay: false, rng }),
    );
    act(() => result.current.seekToPosition(2));
    expect(result.current.current?.mediaId).toBe(3);
    expect(result.current.progressLabel).toBe('3 / 3');
  });

  it('play/pause toggles playing', () => {
    const items = [img(1)];
    const { result } = renderHook(() =>
      usePlayer({ items, secondsPerImage: 99, videoLoopCount: 1, autoPlay: false, rng }),
    );
    expect(result.current.playing).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => result.current.pause());
    expect(result.current.playing).toBe(false);
  });
});
