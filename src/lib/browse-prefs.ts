// The discovery browse preferences — the SORT and the popularity WINDOW —
// persisted so they survive a reload.
//
// ---------------------------------------------------------------------------
// 🔴 WHY THIS IS NOT `localStorage`, AND WHY THE OBVIOUS CHOICE IS THE WRONG ONE
// ---------------------------------------------------------------------------
// This block runs in an iframe the platform sandboxes as `allow-scripts
// allow-forms`, deliberately WITHOUT `allow-same-origin` (`block.manifest.json`
// -> `iframe.sandbox`; the manifest validator BANS `allow-same-origin`). The
// document therefore has an OPAQUE ORIGIN, and there is no origin to key web
// storage against — reading the `localStorage` property itself throws:
//
//   SecurityError: Failed to read the 'localStorage' property from 'Window':
//   The document is sandboxed and lacks the 'allow-same-origin' flag.
//
// `@civitai/blocks-react` imports `@civitai/app-sdk/blocks`, which installs a
// spec-shaped IN-MEMORY `Storage` over the unusable global so no dependency can
// take the app down. That shim is what makes `settings.ts` and `view-modes.ts`
// safe — but read its own contract (`@civitai/app-sdk/dist/safe-storage`, sdk
// 0.39.0):
//
//   "The fallback is session-scoped — nothing survives a reload — which is the
//    honest semantic at an opaque origin. [...] the durable per-user store is
//    the platform's app-storage API."
//
// So a `localStorage` key here would read and write perfectly, pass every jsdom
// test, and PERSIST NOTHING IN PRODUCTION. It is the exact shape of a vacuous
// green: the mechanism under test is the shim, not the platform. That is why
// this module talks to the host's app-storage bridge instead.
//
// A URL query param was rejected for a different reason: the block's own URL is
// not the one the viewer sees. The address bar belongs to the HOST page
// (`civitai.com/apps/run/playable-collections`), so an iframe-internal param
// buys no shareability, and a host-page reload re-creates the iframe from its
// original `src` — taking any `history.replaceState` state with it. (The
// existing `lib/deep-link.ts` hash lives under the same constraint; widening it
// was not an option for state that must outlive a reload.)
//
// ---------------------------------------------------------------------------
// 🔴 WHAT THIS CANNOT DO: ANONYMOUS VIEWERS
// ---------------------------------------------------------------------------
// App storage is keyed per (block instance, VIEWER). For an anonymous viewer the
// host resolves `get` to `null` and REJECTS `set`. There is no fourth option —
// the sandbox denies web storage and the platform has no anon-keyed store — so a
// signed-out viewer always lands on the defaults. Both calls here are
// best-effort and neither surfaces an error, because "your sort did not stick"
// is not something to interrupt a signed-out browse with.
//
// ---------------------------------------------------------------------------
// 🔴 ONE MECHANISM, ONE KEY, ONE RECORD — THE POINT OF THIS FILE
// ---------------------------------------------------------------------------
// `sort` and `period` are persisted TOGETHER, as one JSON record under one key,
// through one setter path. That is deliberate and it is the invariant
// `App.test.tsx`'s relationship guard pins: before this module the two controls
// agreed by both being un-persisted `useState`, and a comment in `App.tsx` asked
// the operator to decide whether both should persist. They should, and giving
// one a mechanism the other lacks is the drift the guard exists to catch. With a
// single record there is no way to persist one without the other — the guard
// checks the record's field set so it fails if that ever stops being true.

import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_PERIOD, isCollectionPeriod, type CollectionPeriod } from './period.js';
import type { CollectionSort } from '../types.js';

/**
 * The sort a first visit lands on (feedback #3 — Popular, not Newest).
 *
 * Lives here rather than inline in `App.tsx` so the two defaults this module
 * restores to sit side by side with each other: a first visit and a failed read
 * must land on the SAME pair, and that is easier to keep true when one object
 * declares both.
 */
export const DEFAULT_SORT: CollectionSort = 'popular';

/** Is this one of the two known sorts? Narrows an unknown string. */
export function isCollectionSort(value: unknown): value is CollectionSort {
  return value === 'newest' || value === 'popular';
}

/** The discovery controls that survive a reload. */
export interface BrowsePrefs {
  sort: CollectionSort;
  period: CollectionPeriod;
}

/**
 * The app-storage key holding the record.
 *
 * Namespaced like the (session-scoped) web-storage keys in `settings.ts` so the
 * two families read the same at a glance, even though they reach different
 * stores. App storage is per-app already, so the prefix is for humans.
 */
export const BROWSE_PREFS_KEY = 'playable-collections:browse-prefs';

/** What a first visit — and any unreadable record — falls back to. */
export const DEFAULT_BROWSE_PREFS: BrowsePrefs = {
  sort: DEFAULT_SORT,
  period: DEFAULT_PERIOD,
};

/**
 * Narrow an arbitrary host value to a `BrowsePrefs`, PER FIELD.
 *
 * 🔴 Per-field, not all-or-nothing, and that is the whole robustness story. The
 * host stores arbitrary JSON and this key outlives the app: a record written by
 * a future version may carry a period this build has never heard of, or a field
 * that has since been renamed. Rejecting the whole record on one bad field would
 * throw away a perfectly good sort; keeping a bad field would put an unknown
 * string into a wire param. So each field is validated against its own enum and
 * independently degrades to its default.
 *
 * Never throws. `null`/`undefined` (unset key, anonymous viewer), a string, an
 * array, and a record of garbage all yield exactly `DEFAULT_BROWSE_PREFS`.
 */
export function coerceBrowsePrefs(raw: unknown): BrowsePrefs {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_BROWSE_PREFS };
  }
  const rec = raw as Record<string, unknown>;
  return {
    sort: isCollectionSort(rec.sort) ? rec.sort : DEFAULT_SORT,
    period: isCollectionPeriod(rec.period) ? rec.period : DEFAULT_PERIOD,
  };
}

/**
 * The slice of the host's app-storage bridge this module needs.
 *
 * Structural on purpose: `useAppStorage()` from `@civitai/blocks-react`
 * satisfies it, and so does a three-line fake. Depending on the SHAPE rather
 * than the hook keeps this module testable in the pure-logic (`node`) project,
 * which has no host and no DOM.
 */
export interface BrowsePrefsStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<unknown>;
}

export interface UseBrowsePrefs {
  prefs: BrowsePrefs;
  setSort: (sort: CollectionSort) => void;
  setPeriod: (period: CollectionPeriod) => void;
}

/**
 * The browse prefs: the app renders on the defaults IMMEDIATELY, and the stored
 * record is applied when it arrives.
 *
 * 🔴 NOTHING WAITS ON THE READ, AND THAT IS THE DESIGN. An earlier revision held
 * the first list fetch until the read resolved, behind a deadline timer, a
 * `hydrated` flag on this hook's public surface, a race-guard ref, and two
 * effect dependency arrays in `App`. All of it existed to serve one wait that
 * was never asked for. Rendering on the defaults and correcting them on arrival
 * costs at most one extra list request for a viewer with a NON-default stored
 * record, and removes every one of those moving parts.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHY A WRITE CANNOT HAPPEN BEFORE THE FIRST READ RESOLVES
 * ---------------------------------------------------------------------------
 * The chips are interactive from the first paint, so a viewer can press one
 * while the read is still in flight. A naive write then builds the next record
 * out of whatever this hook currently holds — the DEFAULTS — and stores it,
 * DESTROYING the field the viewer never touched. Concretely, with
 * `{sort: 'newest', period: 'year'}` stored and a slow host, one press of a
 * period chip used to write `{sort: 'popular', period: 'day'}`: the stored sort
 * is gone, permanently, and the reply that would have revealed it is discarded a
 * moment later.
 *
 * So this hook holds ONE invariant, and every other rule here follows from it:
 *
 *   🔴 A RECORD IS ONLY EVER WRITTEN ON TOP OF A RECORD THAT WAS ACTUALLY READ.
 *
 * Before the read resolves, a choice updates the UI and is BUFFERED (`pending`)
 * rather than written. When the read lands, the buffer is replayed ON TOP of the
 * stored record — so the viewer's press wins on the field they touched and the
 * stored value survives on the field they did not — and that merged record is
 * what gets written.
 *
 * If the read REJECTS (host down, transport timeout) the stored record's content
 * is never learned, so writing at all could destroy it: this hook then keeps the
 * choice session-local and writes nothing, for the rest of the mount. That is
 * deliberately the conservative branch. It costs little in practice — the
 * ordinary anonymous case RESOLVES to `null` rather than rejecting, and a host
 * that cannot answer `APP_STORAGE_GET` is not going to service an
 * `APP_STORAGE_SET` either — and it buys "a transient read failure can never
 * silently eat a viewer's stored preference".
 */
export function useBrowsePrefs(
  storage: BrowsePrefsStore,
  opts: { enabled?: boolean } = {},
): UseBrowsePrefs {
  // 🔴 `enabled` IS THE HOST-READINESS GATE, AND IT IS NOT OPTIONAL IN PRACTICE.
  // App storage is a postMessage round-trip, and the host is not listening until
  // `BLOCK_INIT` has landed (`useBlockContext().ready`). A read posted before
  // that is not queued — it is simply never answered, and then costs the
  // transport's full 30 s timeout. `App` therefore passes `ready` here, the same
  // signal it already gates every other fetch on.
  const enabled = opts.enabled ?? true;
  const [prefs, setPrefs] = useState<BrowsePrefs>(() => ({ ...DEFAULT_BROWSE_PREFS }));
  /** Mirrors `prefs` so a setter can build the next record without a stale closure. */
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /**
   * Has a stored record been read?
   *
   * Two jobs, and they are the same condition: it licenses a WRITE (see the
   * invariant above — a record we never read is a record we must not overwrite),
   * and it makes the restore happen AT MOST ONCE.
   *
   * 🔴 The at-most-once half is not belt-and-braces. This effect keys on the
   * `storage` object's identity, and that identity is stable only because
   * `useAppStorage` happens to `useMemo(…, [])` it. A second restore firing —
   * an SDK that stopped memoising, a caller passing a fresh object — would land
   * with the pre-read buffer already drained, and would therefore overwrite a
   * choice the viewer had since made with the older stored value. Latching here
   * means this hook does not depend on someone else's memoisation for its
   * correctness.
   *
   * 🔴 STRICTMODE IS NOT ONE OF THE ROUTES THIS REF COVERS, and an earlier
   * revision of this comment credited it here. Measured on this hook against a
   * store whose `get` is held open: under `<StrictMode>` the effect's second
   * setup runs BEFORE any read has resolved, so `restoredRef` is still `false`
   * and the second read goes out — `strictModeReads: 2` against
   * `plainReads: 1`. What covers the double-invoke is `cancelled`: React runs an
   * effect's cleanup before re-running it, so the FIRST read's `.then` returns
   * early and only the second one is applied (measured by resolving the two
   * reads with different records — the first record never reaches `prefs`).
   * The cost is one extra `APP_STORAGE_GET`, and it is dev-only: React does not
   * double-invoke effects in production builds.
   *
   * Stays `false` forever if the read rejects: no read, no write, no restore.
   *
   * 🔴 IT IS CHECKED IN EXACTLY ONE PLACE, AND THAT IS A CORRECTION. It used to
   * be checked twice — at the top of the effect AND again in the `.then` — and
   * the second one was redundant, not belt-and-braces. An adversarial mutation
   * sweep measured each site SURVIVING alone against a fully green suite, with
   * only the both-sites mutant killed: a guard pair that reads as pinned and is
   * not, where a maintainer simplifying either one away sees green.
   *
   * Why the `.then` one could go rather than this one: a read can only land
   * while it belongs to the CURRENT effect instance, because React runs an
   * effect's cleanup before re-running it and that cleanup sets `cancelled`. So
   * a `.then` that gets past `cancelled` is necessarily from the effect that is
   * live right now — and this check is what stopped that effect from starting
   * after a restore in the first place. `cancelled` covers the overlap case
   * (`browse-prefs.test.tsx` pins it with two reads genuinely in flight at once);
   * this ref covers the after-the-fact case, and additionally spares the host a
   * round-trip nobody would have used. Each is now pinned by its own test.
   */
  const restoredRef = useRef(false);
  /** Choices made before the read resolved, replayed on top of what it returns. */
  const pendingRef = useRef<Partial<BrowsePrefs>>({});

  useEffect(() => {
    if (!enabled || restoredRef.current) return;
    let cancelled = false;

    void storage
      .get(BROWSE_PREFS_KEY)
      .then((raw) => {
        if (cancelled) return;
        // The stored record, with any choice the viewer already made laid over
        // the top: their press is the newer truth on the field they touched, and
        // the stored value is the only truth on the field they did not.
        const pending = pendingRef.current;
        const merged: BrowsePrefs = { ...coerceBrowsePrefs(raw), ...pending };
        pendingRef.current = {};
        restoredRef.current = true;
        prefsRef.current = merged;
        setPrefs(merged);
        // Flush a buffered choice now that it can be merged rather than guessed.
        if (Object.keys(pending).length > 0) {
          void storage.set(BROWSE_PREFS_KEY, merged).catch(() => {});
        }
      })
      .catch(() => {
        // An anonymous viewer, a host that predates app storage, a timed-out
        // request. None of them is worth a message: the defaults are a complete,
        // working browse surface — and `restoredRef` stays false, so nothing
        // is written over a record we never saw.
      });

    return () => {
      cancelled = true;
    };
  }, [storage, enabled]);

  const persist = useCallback(
    (patch: Partial<BrowsePrefs>) => {
      const next: BrowsePrefs = { ...prefsRef.current, ...patch };
      prefsRef.current = next;
      setPrefs(next);
      if (!restoredRef.current) {
        // Buffer, do not write. See the invariant above.
        pendingRef.current = { ...pendingRef.current, ...patch };
        return;
      }
      // Best effort. A rejected write (anonymous viewer, quota, host down) leaves
      // the choice live for this session and simply does not outlive it.
      void storage.set(BROWSE_PREFS_KEY, next).catch(() => {});
    },
    [storage],
  );

  const setSort = useCallback((sort: CollectionSort) => persist({ sort }), [persist]);
  const setPeriod = useCallback((period: CollectionPeriod) => persist({ period }), [persist]);

  return { prefs, setSort, setPeriod };
}
