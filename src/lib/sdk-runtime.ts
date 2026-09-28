// The nine runtime bindings this app used to take from `@civitai/blocks-react`,
// re-expressed on `@civitai/sdk`'s `initialize({ transport })`.
//
// WHY A MODULE AND NOT NINE INLINE REWRITES: the SDK is not hook-shaped. It is
// one async `initialize()` returning clients, so every consumer would otherwise
// have to solve the same three problems — when the client exists, how a snapshot
// field reaches React without re-rendering forever, and which operations are
// still messages rather than HTTP. Those answers belong in one place.
//
// THE SPLIT, WHICH IS THE WHOLE DESIGN. Three groups, and they differ in kind:
//
//   1. SNAPSHOT (ready/viewer/theme/token/hostOrigin) — available SYNCHRONOUSLY
//      from the transport, before `initialize()` resolves, because the bridge
//      transport already holds `BLOCK_INIT`. These must not wait on anything: the
//      app paints its boot skeleton off `ready`/`theme`.
//   2. HOST-MEDIATED (resize, sign-in, consent) — still postMessage, and
//      `createHost(transport)` is synchronous, so these need no await either.
//   3. REST (app storage, shared storage, Buzz) — these moved off the bridge onto
//      `/api/v1`, and they are the only group that must wait for
//      `initialize({ transport })` to resolve, because only the AppClient carries
//      the http clients bound to the token session.
//
// 🔴 ONE TRANSPORT, AND IT IS THE BRIDGE'S. `src/lib/sdk-transport.ts` explains
// why (`/ui` keeps constructing the bridge singleton, so a bare `initialize()`
// would stand up a second one). The consequence that matters HERE: the
// `@civitai/blocks-react/testing` Harness drives that same singleton, so every
// existing Harness-mounted test keeps answering group 1 and group 2 unchanged.
// Only group 3 leaves the Harness's reach — it answers HTTP now — which is why
// `configureSdkRuntime({ fetch })` exists rather than a mock-host seam.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';

import { getTransport } from '@civitai/blocks-react';
import { initialize } from '@civitai/sdk';
import type {
  AppClient,
  BlockSnapshot,
  BlockTransport,
  Host,
  Scope,
  SharedItem,
  SharedValue,
  StorageClient,
  Theme,
  ViewerInfo,
} from '@civitai/sdk';
import { createHost } from '@civitai/sdk';

import { createSdkTransportAdapter } from './sdk-transport.js';

/** What the viewer's per-pool balance looks like — the shape `blocks/buzz` returns. */
export interface BuzzPools {
  blue: number;
  green: number;
  yellow: number;
}

export interface SdkRuntimeOptions {
  /**
   * The transport the SDK reads. Defaults to the bridge singleton adapted by
   * `createSdkTransportAdapter()`; a test passes a fake so no iframe is needed.
   */
  transport?: BlockTransport;
  /**
   * Injected into `initialize`, so group 3 (the REST clients) can be answered at
   * the `fetch` boundary. 🔴 THIS IS THE SEAM THE PORT CREATES. Before the port
   * a test seeded app/shared storage through the mock HOST; after it, those calls
   * are HTTP and the host never sees them, so a test that kept seeding the host
   * would pass while exercising nothing.
   */
  fetch?: typeof globalThis.fetch;
  /** Override the site base URL (`/api/v1` by default) — dev harness only. */
  siteUrl?: string;
}

let options: SdkRuntimeOptions = {};
let transportSingleton: BlockTransport | null = null;
let bridgeWrapped: unknown = null;
let appPromise: Promise<AppClient> | null = null;

/**
 * Set the runtime's options — the transport, the `fetch` the REST clients use, and
 * the site base URL. `src/main.tsx` calls it for the dev harness; production needs
 * no call at all, because every default is already right there.
 *
 * 🔴 IT DISCARDS ANY AppClient BUILT UNDER THE PREVIOUS OPTIONS, and that is the
 * whole contract. The first version of this function THREW when called after the
 * client existed, on the reasoning that a mid-flight `fetch` swap would otherwise
 * be silently ignored. That reasoning was right about the hazard and wrong about
 * the remedy: the hazard is a STALE CLIENT, and dropping the client removes it,
 * whereas refusing merely reports it — and it refused a legitimate case this
 * repo's own suite contains (a test that renders the app twice, with different
 * props, inside one test). So the client is dropped instead. The next `app()` is
 * built from the options just installed.
 *
 * It is NOT a full reset: `resetSdkRuntime` is still what tests use between cases,
 * because that also clears options back to the defaults.
 */
export function configureSdkRuntime(next: SdkRuntimeOptions): void {
  options = next;
  transportSingleton = next.transport ?? null;
  bridgeWrapped = null;
  appPromise = null;
}

/**
 * Drop all runtime state. A test seam, and the counterpart every singleton needs:
 * without it the first test's transport and fetch leak into every later test in
 * the same file.
 */
export function resetSdkRuntime(): void {
  options = {};
  transportSingleton = null;
  bridgeWrapped = null;
  appPromise = null;
}

/**
 * The one transport.
 *
 * 🔴 THE CACHE IS KEYED ON THE BRIDGE TRANSPORT'S IDENTITY, AND THAT IS NOT
 * DEFENSIVE POLISH — IT IS REQUIRED BY THIS REPO'S TEST SETUP. The bridge's
 * transport is a process-wide singleton that `resetTransport()` NULLS, so the next
 * `getTransport()` returns a brand-new object; `src/test-setup.ts` calls
 * `resetHarnessTransport()` in a global `beforeEach`, i.e. before EVERY dom test.
 * A plain `??=` would therefore wrap the first test's transport and keep wrapping
 * it after it had been disposed — every later test reading a dead snapshot. The
 * AppClient is bound to the transport too (its session and host both close over
 * it), so a swap must drop that as well.
 *
 * An explicitly configured transport is never re-derived: a test that passed one
 * owns it, and silently replacing it with the singleton would be worse than any
 * staleness this guards against.
 */
function transport(): BlockTransport {
  if (options.transport) return options.transport;
  const bridge = getTransport();
  if (transportSingleton === null || bridge !== bridgeWrapped) {
    bridgeWrapped = bridge;
    transportSingleton = createSdkTransportAdapter(bridge) as BlockTransport;
    appPromise = null;
  }
  return transportSingleton;
}

/**
 * The one AppClient promise, created on first use.
 *
 * 🔴 A REJECTION MUST NOT BE CACHED, AND `??=` ALONE CACHES IT FOREVER.
 * `initialize()` awaits `ready(transport, 10_000)` and REJECTS with
 * `BridgeError('unavailable','BLOCK_INIT')` if the host has not posted
 * `BLOCK_INIT` inside 10 s. `??=` never reassigns a settled promise, so without
 * the `.catch` below that one rejection becomes the answer to every later
 * `app()` for the whole life of the page — and nothing in production can reset
 * it: `configureSdkRuntime`/`resetSdkRuntime` are test-only, and the
 * bridge-identity swap in `transport()` never fires because `getTransport()`
 * caches forever.
 *
 * What that costs, all at once and all silently: app storage stops loading and
 * persisting, shared storage leaves the popular rail permanently empty and drops
 * votes, the Buzz row errors with `refetchBalance()` as a DEAD control (it
 * re-awaits the same rejected promise), the host consent dialog never opens, and
 * `useBlockToken().refresh` rejects — so the 401-retry in `lib/api.ts` re-issues
 * with the same stale token and every call ends as "session expired", advice no
 * viewer can act on because only a reload clears it.
 *
 * 🔴 THIS IS A REGRESSION THIS PORT INTRODUCED, not an inherited flaw. Before
 * the port these hooks used `sendTypedRequest`, and `IframeTransport.dispatch`
 * QUEUES outbound messages until `parentOrigin` is set and then flushes them —
 * nothing here consumed `waitForInit()`, so a late `BLOCK_INIT` recovered
 * cleanly. The port replaced a queue with a hard deadline.
 *
 * Dropping the cache on rejection makes the next `app()` retry. It does not
 * retry automatically — a caller that wants that must re-invoke — which is the
 * pre-port behaviour and enough to make a late `BLOCK_INIT` recoverable.
 */
function app(): Promise<AppClient> {
  if (appPromise === null) {
    // Named before the `.catch` closure can reference it, so the identity check
    // below does not depend on temporal-dead-zone timing to be correct.
    const pending: Promise<AppClient> = initialize({
      transport: transport(),
      fetch: options.fetch,
      ...(options.siteUrl === undefined ? {} : { siteUrl: options.siteUrl }),
    }).catch((err: unknown) => {
      // Clear the slot only while it still holds THIS promise. A
      // `configureSdkRuntime` or a transport swap during the in-flight
      // `initialize` has already replaced it, and clobbering the newer promise
      // would reintroduce exactly the staleness `transport()` exists to prevent.
      if (appPromise === pending) appPromise = null;
      throw err;
    });
    appPromise = pending;
  }
  return appPromise;
}

/** The host client. Synchronous — `createHost` needs only the transport. */
function host(): Host {
  return createHost(transport());
}

// ---------------------------------------------------------------------------
// Group 1 — the snapshot
// ---------------------------------------------------------------------------

/**
 * Read one field out of the live snapshot.
 *
 * 🔴 `select` MUST RETURN A FIELD, NEVER A FRESH OBJECT. `useSyncExternalStore`
 * bails out on `Object.is`, so a selector composing `{ a, b }` returns a new
 * identity every call, never compares equal, and re-renders forever. The
 * transport adapter memoises the snapshot itself for exactly this reason; a
 * composing selector here would throw that away one layer up. Compose with
 * `useMemo` on the fields instead, as `useBlockContext` does below.
 */
export function useBlockSnapshot<T>(select: (snapshot: BlockSnapshot) => T): T {
  const t = transport();
  const subscribe = useCallback((onChange: () => void) => t.snapshot.subscribe(onChange), [t]);
  const get = useCallback(() => select(t.snapshot.get()), [t, select]);
  return useSyncExternalStore(subscribe, get, get);
}

const selectReady = (s: BlockSnapshot) => s.ready;
const selectViewer = (s: BlockSnapshot) => s.viewer;
const selectTheme = (s: BlockSnapshot) => s.theme;
const selectToken = (s: BlockSnapshot) => s.token;
const selectHostOrigin = (s: BlockSnapshot) => s.hostOrigin;
const selectMaxBrowsingLevel = (s: BlockSnapshot) => s.maxBrowsingLevel;
const selectEffectiveBrowsingLevel = (s: BlockSnapshot) => s.effectiveBrowsingLevel;

export interface BlockContextValue {
  ready: boolean;
  viewer: ViewerInfo | null;
  theme: Theme;
}

/** `{ ready, viewer, theme }`, as the bridge hook of the same name returned. */
export function useBlockContext(): BlockContextValue {
  const ready = useBlockSnapshot(selectReady);
  const viewer = useBlockSnapshot(selectViewer);
  const theme = useBlockSnapshot(selectTheme);
  return useMemo(() => ({ ready, viewer, theme }), [ready, viewer, theme]);
}

export interface BlockTokenValue {
  raw: string;
  scopes: string[];
  /**
   * Force an immediate re-mint, for the 401-retry path. Resolves once the new
   * token has been applied to the snapshot.
   */
  refresh: () => Promise<void>;
}

/**
 * The block JWT plus a `refresh()`.
 *
 * ⚠ ONE DELIBERATE IMPROVEMENT ON THE BRIDGE HOOK, and App.tsx's comment about
 * it is now stale rather than wrong: the bridge returned `{...token, refresh}`,
 * a FRESH object every render, which is why the app memoises its HTTP client on
 * the `token.raw` STRING and reads the live token through a ref. This returns a
 * value memoised on the snapshot's token identity, so the object is stable
 * between mints. The app's `raw`-keyed memo stays correct either way — it is
 * left in place because it is the narrower claim, not because it is still forced.
 *
 * `refresh` goes out as `REQUEST_TOKEN` over the adapter, which is the one
 * request type `sdk-transport.ts` maps (to `TOKEN_REFRESH_RESPONSE`) — so the
 * bridge transport applies the new token to the snapshot this hook reads, and
 * the re-render follows from the same place it always did.
 */
export function useBlockToken(): BlockTokenValue {
  const token = useBlockSnapshot(selectToken);
  return useMemo(
    () => ({
      raw: token.raw,
      scopes: token.scopes,
      refresh: async () => {
        const client = await app();
        await client.getToken({ fresh: true });
      },
    }),
    [token],
  );
}

/**
 * The allowlist-VALIDATED parent origin, or `undefined` until `BLOCK_INIT`.
 *
 * 🔴 `undefined` RATHER THAN THE SNAPSHOT'S `null`, and the conversion is the
 * only thing this wrapper does: the app's gate is `host && tokenRaw`, and both
 * falsy values behave identically there, but the bridge hook's declared type was
 * `string | undefined` and every consumer is written against it. Narrowing the
 * change to the transport keeps this a port, not a refactor.
 *
 * 🔴 NO FALLBACK IS ADDED HERE, EVER. See `sdk-transport.ts`: this value becomes
 * the base URL a money-scoped bearer token is sent to, so substituting
 * `location.origin` or `document.referrer` for a not-ready state would turn it
 * into a token-exfiltration vector.
 */
export function useHostOrigin(): string | undefined {
  return useBlockSnapshot(selectHostOrigin) ?? undefined;
}

/** The domain ceiling and the host's per-viewer narrowing of it, raw. */
export function useBrowsingLevels(): { max: number | undefined; effective: number | undefined } {
  const max = useBlockSnapshot(selectMaxBrowsingLevel);
  const effective = useBlockSnapshot(selectEffectiveBrowsingLevel);
  return useMemo(() => ({ max, effective }), [max, effective]);
}

// ---------------------------------------------------------------------------
// Group 2 — host-mediated, still postMessage
// ---------------------------------------------------------------------------

/**
 * Keep the host iframe sized to `ref`'s content.
 *
 * `host.autoResize(element)` owns the observer and the initial report, and
 * returns its own teardown — so this hook is a lifecycle wrapper and nothing
 * more. It waits for the element: `ref.current` is null on the first effect run
 * for a ref attached below it in the tree.
 */
export function useBlockResize(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return host().autoResize(element);
  }, [ref]);
}

/** `{ requestSignIn }` — asks the host to open its sign-in flow. */
export function useRequestSignIn(): { requestSignIn: () => void } {
  const requestSignIn = useCallback(() => host().requestSignIn(), []);
  return useMemo(() => ({ requestSignIn }), [requestSignIn]);
}

/**
 * How long a pending consent request is held open before its listeners are
 * released. The viewer is not on a clock — the host's dialog is theirs to leave
 * open — so this is deliberately generous; it exists only so a declined request
 * cannot retain a snapshot subscription for the life of the page.
 */
const CONSENT_WAIT_MS = 5 * 60_000;

/**
 * `{ requestConsent }` — fire-and-forget, exactly as the bridge hook was.
 *
 * 🔴 THE SDK's `requestGrants` IS AWAITABLE AND THE BRIDGE's WAS NOT, AND THAT
 * DIFFERENCE HAD TO BE HANDLED RATHER THAN CAST AWAY. `requestGrants` resolves
 * `true` when the re-minted token carries the scopes, `false` on
 * `CONSENT_UNAVAILABLE` — and against a viewer who simply closes the dialog it
 * resolves NEITHER, holding a snapshot subscription and a message listener per
 * press. The app's call sites are fire-and-forget by design (on grant the host
 * re-mints and the snapshot flips the derived predicate; declining changes
 * nothing and must raise no error), so:
 *
 *   - the promise is not awaited, preserving the call sites' semantics;
 *   - it is bounded by a signal, so an abandoned dialog releases its listeners;
 *   - the rejection that abort produces is swallowed HERE, because an unhandled
 *     rejection in a click handler is a console error a viewer can produce at
 *     will by closing a dialog.
 *
 * ⚠ `scopes` IS THE SDK's `Scope` UNION, NOT `string[]`, and that is a deliberate
 * tightening rather than an accident of the signature: a scope this platform does
 * not define is now a compile error at the call site instead of a runtime
 * `CONSENT_UNAVAILABLE` nobody traces back to a typo. The app's own constants in
 * `src/scopes.ts` are `const` string literals, so they satisfy it unchanged.
 */
export function useRequestConsent(): { requestConsent: (args: { scopes: readonly Scope[] }) => void } {
  const requestConsent = useCallback(({ scopes }: { scopes: readonly Scope[] }) => {
    void app()
      .then((client) => client.requestGrants(scopes, { signal: AbortSignal.timeout(CONSENT_WAIT_MS) }))
      .catch(() => {
        /* declined, abandoned, or aborted — all "nothing changed", never an error */
      });
  }, []);
  return useMemo(() => ({ requestConsent }), [requestConsent]);
}

// ---------------------------------------------------------------------------
// Group 3 — REST
// ---------------------------------------------------------------------------

/**
 * Per-(block instance, viewer) KV.
 *
 * Returns a STABLE façade whose methods await the AppClient internally, rather
 * than `StorageClient | null`. Two reasons, both load-bearing:
 *   - the object goes into `useEffect`/`useMemo` dependency arrays (see
 *     `lib/browse-prefs.ts`), and the bridge hook documented itself as stable;
 *   - a `null` would make every call site grow a branch for a state that lasts
 *     milliseconds and that the app already gates on `ready`.
 */
export function useAppStorage(): StorageClient {
  return useMemo<StorageClient>(
    () => ({
      get: async (key, opts) => (await app()).storage.get(key, opts),
      set: async (key, value, opts) => (await app()).storage.set(key, value, opts),
      delete: async (key, opts) => (await app()).storage.delete(key, opts),
      list: async (query, opts) => (await app()).storage.list(query, opts),
      getQuota: async (opts) => (await app()).storage.getQuota(opts),
    }),
    [],
  );
}

/**
 * Where the shared-storage vote route lives, relative to the site base URL.
 *
 * 🔴 SPELLED OUT HERE BECAUSE THE SDK DELIBERATELY DOES NOT CARRY IT.
 * `starters#479` decided `AppClient.sharedStorage` is GENERIC KEY-VALUE ONLY —
 * `list`/`get`/`append`/`update`/`withdraw`. `vote`, `unvote`, `counts`, `top`,
 * `increment` and `report` are app-layer by that decision, so the eleven routes
 * existing is not a gap the SDK is expected to close.
 *
 * Verified against the route rather than guessed (civitai `origin/main`,
 * `src/pages/api/v1/blocks/shared-storage/vote.ts`): POST, body `{ key }`,
 * response `{ count }` — the row's new aggregate tally — under scope
 * `apps:storage:shared:write`. Its docblock records that a double vote is a
 * no-op and the tally never inflates, which is what makes `recordPlay`'s
 * vote-then-read sequence safe to retry.
 */
const SHARED_VOTE_ROUTE = 'blocks/shared-storage/vote';

/** The three shared-storage operations this app performs. */
export interface SharedStorageFacade {
  list(query?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    items: SharedItem[];
    nextCursor?: string;
  }>;
  append(value: SharedValue): Promise<{ key: string }>;
  vote(key: string): Promise<number>;
}

/**
 * Cross-user shared storage: `list` and `append` from the SDK client, `vote`
 * app-layer over `app.site` per the decision recorded on `SHARED_VOTE_ROUTE`.
 *
 * Stable identity, for the same reason as `useAppStorage`.
 */
export function useSharedStorage(): SharedStorageFacade {
  return useMemo<SharedStorageFacade>(
    () => ({
      list: async (query) => (await app()).sharedStorage.list(query),
      append: async (value) => (await app()).sharedStorage.append(value),
      vote: async (key) => {
        const reply = await (await app()).site.post<{ count?: unknown }>(SHARED_VOTE_ROUTE, { key });
        // 🔴 ASSERTED, NOT COERCED. `Number(undefined)` is NaN and `?? 0` would
        // report a vote that did not land as a tally of zero — and `recordPlay`
        // writes this number into the popular rail, so a silent 0 is a play count
        // the rail then ranks on. A malformed reply is a failure, not a count.
        if (typeof reply?.count !== 'number' || !Number.isFinite(reply.count)) {
          throw new Error('shared-storage vote: reply carried no numeric `count`');
        }
        return reply.count;
      },
    }),
    [],
  );
}

export interface BuzzBalanceValue {
  balance: BuzzPools | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Where the viewer's per-pool balance comes from.
 *
 * 🔴 THIS ROUTE'S EXISTENCE IS THE REASON THE PORT CAN MOVE THE BALANCE AT ALL,
 * and App.tsx carried a comment saying the opposite. `GET /api/v1/blocks/buzz`
 * was deleted once and RESTORED by `civitai#5051` (`ca57ac0fbb`, 2026-09-23)
 * specifically on the bridge's three-account shape: its docblock states it
 * returns the SAME projection as the `blocks.getMyBuzzBalance` tRPC mutation
 * `useBuzzBalance()` reads, "field for field, so a consumer can switch
 * transports without a shape change". A bare `{ blue, green, yellow }`, no
 * envelope, scope `buzz:read:self`, anon rejected.
 *
 * ⚠ ONE KNOWN DIVERGENCE, from that same docblock rather than from measurement
 * here: the tRPC procedure also evaluates the `app-blocks-enabled` kill-switch
 * and charges the per-instance catalog rate-limit bucket; this route does
 * neither. Recorded because it is a behaviour difference the port inherits, not
 * one it introduces.
 */
const BUZZ_ROUTE = 'blocks/buzz';

/**
 * The viewer's per-pool Buzz balance. Fetches once the AppClient exists, and
 * exposes `refetch` for after a spend.
 *
 * 🔴 LATE REPLIES ARE DROPPED ON UNMOUNT, which the bridge hook also did. Under
 * React 18+ a `setState` after unmount is a silent no-op rather than a warning,
 * so this guard is invisible to a mutation that deletes it — it is here for the
 * abandoned-fetch case (a `refetch` in flight when the view closes), not for a
 * console warning that no longer exists.
 */
export function useBuzzBalance(): BuzzBalanceValue {
  const [balance, setBalance] = useState<BuzzPools | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const pools = await (await app()).site.get<BuzzPools>(BUZZ_ROUTE);
        if (!current || !live.current) return;
        setBalance(pools);
      } catch (cause) {
        if (!current || !live.current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (current && live.current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return useMemo(() => ({ balance, loading, error, refetch }), [balance, loading, error, refetch]);
}
