// @vitest-environment jsdom
// (renderHook needs a DOM; .test.ts otherwise defaults to the node environment.)
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebouncedValue } from './use-debounced-value.js';

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the initial value synchronously', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 300));
    expect(result.current).toBe('a');
  });

  it('only updates after the delay elapses with no further change', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: 'a' },
    });

    rerender({ v: 'ab' });
    rerender({ v: 'abc' });
    // Still the old value before the delay — mid-typing.
    expect(result.current).toBe('a');

    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe('a');

    act(() => vi.advanceTimersByTime(1));
    // Settles directly to the LATEST value (intermediate keystrokes are coalesced).
    expect(result.current).toBe('abc');
  });

  it('resets the timer on each change (no stale intermediate emits)', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: 'x' },
    });
    rerender({ v: 'xy' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ v: 'xyz' }); // resets the 300ms window
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('x'); // 400ms total, but only 200ms since last change
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe('xyz');
  });
});
