// `useBrowsePrefs` against a fake store (the `dom` project).
//
// The hook takes a structural `BrowsePrefsStore` precisely so these cases can be
// driven without a host: a rejecting store, a store that never settles, and a
// store that already holds a record (which is what a reload looks like) are all
// awkward to arrange through the mock host and trivial here.

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  BROWSE_PREFS_KEY,
  DEFAULT_BROWSE_PREFS,
  type BrowsePrefsStore,
  useBrowsePrefs,
} from './browse-prefs.js';

/** A store whose `get` resolves `value` and whose `set` records the writes. */
function fakeStore(value: unknown = null): BrowsePrefsStore & { writes: Array<{ key: string; value: unknown }> } {
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    writes,
    get: async () => value as never,
    set: async (key, v) => {
      writes.push({ key, value: v });
      return { ok: true };
    },
  };
}

describe('useBrowsePrefs — restore', () => {
  it('🔴 restores BOTH fields from a store that already holds a record', async () => {
    // The reload case. Both fixture values are non-default.
    const store = fakeStore({ sort: 'newest', period: 'year' });
    const { result } = renderHook(() => useBrowsePrefs(store));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.prefs).toEqual({ sort: 'newest', period: 'year' });
  });

  it('starts on the defaults before the read resolves', () => {
    const { result } = renderHook(() => useBrowsePrefs(fakeStore({ sort: 'newest', period: 'year' })));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.prefs).toEqual(DEFAULT_BROWSE_PREFS);
  });

  it('lands on the defaults when the key is unset', async () => {
    const { result } = renderHook(() => useBrowsePrefs(fakeStore(null)));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.prefs).toEqual(DEFAULT_BROWSE_PREFS);
  });
});

describe('useBrowsePrefs — the app must never hang on storage', () => {
  it('🔴 hydrates on the DEADLINE when the store never settles', async () => {
    // The failsafe that matters: the transport's own request timeout is 30 s, so
    // without this the grid would sit on a skeleton for half a minute whenever
    // the host does not answer. A store whose promise never settles is exactly
    // that host.
    const store: BrowsePrefsStore = { get: () => new Promise(() => {}), set: async () => ({ ok: true }) };
    const { result } = renderHook(() => useBrowsePrefs(store, { deadlineMs: 10 }));
    expect(result.current.hydrated).toBe(false);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.prefs).toEqual(DEFAULT_BROWSE_PREFS);
  });

  it('🔴 hydrates when the read REJECTS (anonymous viewer, host down)', async () => {
    const store: BrowsePrefsStore = {
      get: async () => {
        throw new Error('anonymous');
      },
      set: async () => ({ ok: true }),
    };
    const { result } = renderHook(() => useBrowsePrefs(store));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.prefs).toEqual(DEFAULT_BROWSE_PREFS);
  });

  it('🔴 a write that REJECTS still applies the choice for this session', async () => {
    // An anonymous viewer cannot persist, but their chip must still work.
    const store: BrowsePrefsStore = {
      get: async () => null,
      set: async () => {
        throw new Error('anonymous');
      },
    };
    const { result } = renderHook(() => useBrowsePrefs(store));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => result.current.setPeriod('day'));
    await waitFor(() => expect(result.current.prefs.period).toBe('day'));
  });

  it('issues no read at all until it is enabled', async () => {
    // `App` passes the host-readiness flag here: a read posted before BLOCK_INIT
    // is never answered, and then costs the transport's full timeout.
    const get = vi.fn(async () => null);
    const store: BrowsePrefsStore = { get, set: async () => ({ ok: true }) };
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useBrowsePrefs(store, { enabled: on }), {
      initialProps: { on: false },
    });
    expect(get).not.toHaveBeenCalled();
    expect(result.current.hydrated).toBe(false);

    rerender({ on: true });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(get).toHaveBeenCalledWith(BROWSE_PREFS_KEY);
  });
});

describe('useBrowsePrefs — one mechanism for both controls', () => {
  it('🔴 writes the WHOLE record under ONE key when only the window changes', async () => {
    const store = fakeStore(null);
    const { result } = renderHook(() => useBrowsePrefs(store));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.setPeriod('year'));
    await waitFor(() => expect(store.writes.length).toBe(1));
    expect(store.writes[0]).toEqual({ key: BROWSE_PREFS_KEY, value: { sort: 'popular', period: 'year' } });
  });

  it('🔴 writes the WHOLE record under the SAME key when only the sort changes', async () => {
    const store = fakeStore(null);
    const { result } = renderHook(() => useBrowsePrefs(store));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.setSort('newest'));
    await waitFor(() => expect(store.writes.length).toBe(1));
    expect(store.writes[0]).toEqual({ key: BROWSE_PREFS_KEY, value: { sort: 'newest', period: 'month' } });
  });

  it('🔴 each write carries exactly the two fields — a ledger, not a sample', async () => {
    const store = fakeStore(null);
    const { result } = renderHook(() => useBrowsePrefs(store));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.setPeriod('day'));
    act(() => result.current.setSort('newest'));
    await waitFor(() => expect(store.writes.length).toBe(2));
    for (const w of store.writes) {
      expect(w.key).toBe(BROWSE_PREFS_KEY);
      expect(Object.keys(w.value as object).sort()).toEqual(['period', 'sort']);
    }
    // The second write kept the window chosen by the first — the two controls
    // accumulate into one record rather than overwriting each other.
    expect(store.writes[1].value).toEqual({ sort: 'newest', period: 'day' });
  });

  it("🔴 a late read does not overwrite a choice the viewer has already made", async () => {
    // Past the deadline the app is interactive on the defaults. A reply landing
    // after the viewer pressed a chip must not yank the grid out from under
    // them — and their press is the newer truth, already persisted.
    let release!: (v: unknown) => void;
    const store: BrowsePrefsStore = {
      get: () => new Promise((res) => { release = res; }) as never,
      set: async () => ({ ok: true }),
    };
    const { result } = renderHook(() => useBrowsePrefs(store, { deadlineMs: 10 }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.setPeriod('day'));
    await waitFor(() => expect(result.current.prefs.period).toBe('day'));

    await act(async () => {
      release({ sort: 'newest', period: 'year' });
      await Promise.resolve();
    });
    expect(result.current.prefs).toEqual({ sort: 'popular', period: 'day' });
  });
});
