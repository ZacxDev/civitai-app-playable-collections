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

/**
 * A store whose `get` is held open until the returned `release` is called, and
 * which records its writes. This is the slow host: the app is already
 * interactive while the read is still in flight.
 */
function heldStore(): BrowsePrefsStore & {
  writes: Array<{ key: string; value: unknown }>;
  release: (value: unknown) => void;
  reject: (err: unknown) => void;
} {
  const writes: Array<{ key: string; value: unknown }> = [];
  let release!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const held = new Promise((res, rej) => {
    release = res;
    reject = rej;
  });
  return {
    writes,
    release,
    reject,
    get: () => held as never,
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
    await waitFor(() => expect(result.current.prefs).toEqual({ sort: 'newest', period: 'year' }));
  });

  it('renders on the defaults immediately, without waiting for the read', () => {
    // 🔴 The whole point of deleting the hydration gate: the very first render
    // is usable. Synchronous assertion — no `waitFor`, no flushed microtask.
    const { result } = renderHook(() => useBrowsePrefs(heldStore()));
    expect(result.current.prefs).toEqual(DEFAULT_BROWSE_PREFS);
  });

  it('lands on the defaults when the key is unset', async () => {
    const store = fakeStore(null);
    const { result } = renderHook(() => useBrowsePrefs(store));
    await waitFor(() => expect(store.writes).toEqual([]));
    expect(result.current.prefs).toEqual(DEFAULT_BROWSE_PREFS);
  });

  it('🔴 stays on the defaults when the read REJECTS (anonymous viewer, host down)', async () => {
    const store: BrowsePrefsStore = {
      get: async () => {
        throw new Error('anonymous');
      },
      set: async () => ({ ok: true }),
    };
    const { result } = renderHook(() => useBrowsePrefs(store));
    await act(async () => {
      await Promise.resolve();
    });
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
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setPeriod('day'));
    await waitFor(() => expect(result.current.prefs.period).toBe('day'));
  });

  it('issues no read at all until it is enabled', async () => {
    // `App` passes the host-readiness flag here: a read posted before BLOCK_INIT
    // is never answered, and then costs the transport's full timeout.
    const get = vi.fn(async () => null);
    const store: BrowsePrefsStore = { get, set: async () => ({ ok: true }) };
    const { rerender } = renderHook(({ on }: { on: boolean }) => useBrowsePrefs(store, { enabled: on }), {
      initialProps: { on: false },
    });
    expect(get).not.toHaveBeenCalled();

    rerender({ on: true });
    await waitFor(() => expect(get).toHaveBeenCalledWith(BROWSE_PREFS_KEY));
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE DATA-LOSS CLASS — a write must never be built out of state we have not
// read. These are the regression tests for the bug the hydration gate hid.
// ---------------------------------------------------------------------------
describe('useBrowsePrefs — a write is only ever laid over a record that was READ', () => {
  it('🔴 a chip pressed BEFORE the read resolves does not destroy the stored other field', async () => {
    // The bug, exactly: stored `{sort:'newest', period:'year'}`, a slow host, and
    // one press of a period chip. The pre-fix build wrote
    // `{sort:'popular', period:'day'}` immediately — built from the DEFAULTS,
    // because that is all it had — and the viewer's stored sort was gone for
    // good.
    const store = heldStore();
    const { result } = renderHook(() => useBrowsePrefs(store));

    act(() => result.current.setPeriod('day'));
    // The choice is live on screen straight away...
    expect(result.current.prefs.period).toBe('day');
    // ...but NOTHING has been written, because there is nothing to lay it over.
    expect(store.writes).toEqual([]);

    await act(async () => {
      store.release({ sort: 'newest', period: 'year' });
      await Promise.resolve();
    });

    // The stored sort survived; the pressed window won. Both halves matter.
    expect(result.current.prefs).toEqual({ sort: 'newest', period: 'day' });
    await waitFor(() => expect(store.writes.length).toBe(1));
    expect(store.writes[0]).toEqual({ key: BROWSE_PREFS_KEY, value: { sort: 'newest', period: 'day' } });
  });

  it('🔴 buffers EVERY pre-read choice and replays them all over the stored record', async () => {
    // The mirror field, plus accumulation: two presses before the read lands
    // must both survive, and the untouched stored field must still come back.
    const store = heldStore();
    const { result } = renderHook(() => useBrowsePrefs(store));

    act(() => result.current.setSort('newest'));
    act(() => result.current.setPeriod('week'));
    expect(store.writes).toEqual([]);

    await act(async () => {
      // A stored record whose every field the viewer has since overridden except
      // none — both are overridden here, so the assertion below is about the
      // REPLAY winning, not about the read winning.
      store.release({ sort: 'popular', period: 'year' });
      await Promise.resolve();
    });

    expect(result.current.prefs).toEqual({ sort: 'newest', period: 'week' });
    await waitFor(() => expect(store.writes.length).toBe(1));
    expect(store.writes[0].value).toEqual({ sort: 'newest', period: 'week' });
  });

  it('🔴 writes NOTHING at all when the read REJECTS — the stored record is unknown', async () => {
    // Conservative by construction: a failed read means we never learned what is
    // stored, so any write could destroy it. The choice stays session-local.
    const store = heldStore();
    const { result } = renderHook(() => useBrowsePrefs(store));

    await act(async () => {
      store.reject(new Error('host down'));
      await Promise.resolve();
    });

    act(() => result.current.setPeriod('day'));
    act(() => result.current.setSort('newest'));
    // Both choices are live in the UI...
    expect(result.current.prefs).toEqual({ sort: 'newest', period: 'day' });
    // ...and neither was written.
    await waitFor(() => expect(store.writes).toEqual([]));
  });

  it('🔴 restores AT MOST ONCE — a second read cannot overwrite a later choice', async () => {
    // ⚠️ AN INVARIANT GUARD, NOT REGRESSION COVERAGE — measured GREEN at the
    // pre-change tree, which held a `chosenRef` that covered this case by a
    // different route. It is here because that ref is gone and the property has
    // to be pinned by something: the restore effect keys on the `storage`
    // object's identity, which is stable only because `useAppStorage` memoises
    // it. If a store identity ever changes — a caller, an SDK change,
    // StrictMode — a second restore must not land on top of the viewer.
    const first = fakeStore({ sort: 'newest', period: 'year' });
    const second = fakeStore({ sort: 'popular', period: 'allTime' });
    const { result, rerender } = renderHook(
      ({ store }: { store: BrowsePrefsStore }) => useBrowsePrefs(store),
      { initialProps: { store: first as BrowsePrefsStore } },
    );
    await waitFor(() => expect(result.current.prefs).toEqual({ sort: 'newest', period: 'year' }));

    act(() => result.current.setPeriod('day'));
    rerender({ store: second as BrowsePrefsStore });
    await act(async () => {
      await Promise.resolve();
    });

    // The second store's record never landed, and the viewer's choice stands.
    expect(result.current.prefs).toEqual({ sort: 'newest', period: 'day' });
  });

  it('🔴 a read that never settles writes nothing either', async () => {
    // The third arm of the same rule, and also RED at the pre-change tree: there
    // the write went out immediately as `{sort:'popular', period:'day'}` — the
    // DEFAULT sort — with the real read still in flight.
    const store = heldStore();
    const { result } = renderHook(() => useBrowsePrefs(store));
    act(() => result.current.setPeriod('day'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.prefs.period).toBe('day');
    expect(store.writes).toEqual([]);
  });
});

describe('useBrowsePrefs — one mechanism for both controls', () => {
  it('🔴 writes the WHOLE record under ONE key when only the window changes', async () => {
    const store = fakeStore(null);
    const { result } = renderHook(() => useBrowsePrefs(store));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.setPeriod('year'));
    await waitFor(() => expect(store.writes.length).toBe(1));
    expect(store.writes[0]).toEqual({ key: BROWSE_PREFS_KEY, value: { sort: 'popular', period: 'year' } });
  });

  it('🔴 writes the WHOLE record under the SAME key when only the sort changes', async () => {
    const store = fakeStore(null);
    const { result } = renderHook(() => useBrowsePrefs(store));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.setSort('newest'));
    await waitFor(() => expect(store.writes.length).toBe(1));
    expect(store.writes[0]).toEqual({ key: BROWSE_PREFS_KEY, value: { sort: 'newest', period: 'month' } });
  });

  it('🔴 each write carries exactly the two fields — a ledger, not a sample', async () => {
    const store = fakeStore(null);
    const { result } = renderHook(() => useBrowsePrefs(store));
    await act(async () => {
      await Promise.resolve();
    });

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
});

// ---------------------------------------------------------------------------
// 🔴 THE AT-MOST-ONCE LATCH, PINNED CLAUSE BY CLAUSE
// ---------------------------------------------------------------------------
//
// The restore is protected by TWO independent mechanisms and they cover
// different windows. An adversarial sweep found the suite could not tell them
// apart — each survived being mutated away on its own, and only removing both
// at once turned anything red, which is a guard pair that reads as pinned and is
// not. The hook now checks `restoredRef` in one place; these two cases pin that
// place and the `cancelled` flag SEPARATELY, so simplifying either one away goes
// red on its own test.
describe('useBrowsePrefs — the at-most-once latch, one case per mechanism', () => {
  it('🔴 `restoredRef` — no SECOND read is issued once a record has been restored', () => {
    // Mechanism 1: the effect-entry latch. A changed `storage` identity re-runs
    // the effect; after a restore it must not reach the host at all. Counting
    // reads is the point — a check on the resulting prefs cannot distinguish
    // "never asked" from "asked and discarded the answer", and only one of those
    // costs a postMessage round-trip on every identity change.
    let reads = 0;
    const mk = (value: unknown): BrowsePrefsStore => ({
      get: async () => {
        reads += 1;
        return value as never;
      },
      set: async () => ({ ok: true }),
    });
    const first = mk({ sort: 'newest', period: 'year' });
    const second = mk({ sort: 'popular', period: 'allTime' });

    return (async () => {
      const { result, rerender } = renderHook(
        ({ store }: { store: BrowsePrefsStore }) => useBrowsePrefs(store),
        { initialProps: { store: first } },
      );
      await waitFor(() => expect(result.current.prefs).toEqual({ sort: 'newest', period: 'year' }));
      expect(reads).toBe(1); // positive control: the counter moves at all.

      rerender({ store: second });
      await act(async () => {
        await Promise.resolve();
      });

      // The second store was never asked, and the restored record still stands.
      expect(reads).toBe(1);
      expect(result.current.prefs).toEqual({ sort: 'newest', period: 'year' });
    })();
  });

  it('🔴 `cancelled` — a read still in flight from an EARLIER store cannot land', async () => {
    // Mechanism 2: the per-effect cancellation flag, and the only case where two
    // reads are genuinely in flight at the same time. The first store is still
    // holding its read open when the identity changes, so `restoredRef` is still
    // false and the effect-entry latch above lets the second read through; the
    // second answers and restores. When the FIRST finally answers — with a
    // different record — its cleanup has already cancelled it.
    const first = heldStore();
    const second = heldStore();
    const { result, rerender } = renderHook(
      ({ store }: { store: BrowsePrefsStore }) => useBrowsePrefs(store),
      { initialProps: { store: first as BrowsePrefsStore } },
    );

    rerender({ store: second as BrowsePrefsStore });
    await act(async () => {
      second.release({ sort: 'newest', period: 'year' });
      await Promise.resolve();
    });
    expect(result.current.prefs).toEqual({ sort: 'newest', period: 'year' });

    // The viewer moves on, and only THEN does the abandoned read answer.
    act(() => result.current.setPeriod('day'));
    await act(async () => {
      first.release({ sort: 'popular', period: 'allTime' });
      await Promise.resolve();
    });

    // The stale record did not land on top of either the restore or the choice.
    expect(result.current.prefs).toEqual({ sort: 'newest', period: 'day' });
  });
});
