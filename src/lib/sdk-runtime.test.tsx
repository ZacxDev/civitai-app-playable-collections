// Tests for the nine runtime bindings, against the REAL `@civitai/sdk`.
//
// 🔴 `initialize` IS NOT MOCKED, AND THAT IS THE POINT. The port's whole risk is
// in the SEAM — which route a call lands on, what shape comes back, whether a
// snapshot field reaches React without looping. A mocked `initialize` would move
// every one of those behind a fake and leave the suite asserting my own guesses:
// exactly the "verified in isolation" failure. So these tests drive the real SDK
// with two injected edges, both of which the SDK itself supports:
//
//   - a fake TRANSPORT, whose snapshot says `ready: true`, which is all the SDK's
//     own `ready()` gate requires (`dist/app/index.js:157`);
//   - a fake FETCH, so `app.site` / `app.storage` / `app.sharedStorage` build
//     their real URLs and bodies and this file asserts on them.
//
// What that buys: the vote route, the Buzz route and the storage routes are
// asserted as the STRINGS THAT GO ON THE WIRE, not as a call to a stub.

import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configureSdkRuntime,
  resetSdkRuntime,
  useAppStorage,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBrowsingLevels,
  useBuzzBalance,
  useHostOrigin,
  useRequestConsent,
  useRequestSignIn,
  useSharedStorage,
} from './sdk-runtime.js';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface FakeSnapshot {
  ready: boolean;
  renderMode: 'iframe';
  context: Record<string, unknown>;
  token: { raw: string; scopes: string[]; expiresAt: Date };
  settings: Record<string, unknown>;
  viewer: { id: number; username: string } | null;
  theme: 'light' | 'dark';
  blockInstanceId: string;
  hostOrigin: string | null;
  maxBrowsingLevel?: number;
  effectiveBrowsingLevel?: number;
}

function baseSnapshot(over: Partial<FakeSnapshot> = {}): FakeSnapshot {
  return {
    ready: true,
    renderMode: 'iframe',
    context: {},
    token: { raw: 'jwt-1', scopes: ['apps:storage:read'], expiresAt: new Date('2030-01-01') },
    settings: {},
    viewer: { id: 7, username: 'zed' },
    theme: 'dark',
    blockInstanceId: 'inst-1',
    hostOrigin: 'https://civitai.com',
    ...over,
  };
}

/**
 * A transport whose snapshot the test owns.
 *
 * 🔴 `set()` REPLACES THE OBJECT rather than mutating it, because identity is what
 * the store compares. A mutating fake would make every `useSyncExternalStore`
 * assertion below vacuous — the value would change while the identity did not, so
 * React would correctly skip the re-render and the test would be asserting on the
 * fake's design instead of the code's.
 */
function fakeTransport(initial: FakeSnapshot = baseSnapshot()) {
  let snap = initial;
  const listeners = new Set<() => void>();
  const notify = vi.fn<(message: { type: string; payload?: unknown }) => void>();
  const request = vi.fn(async () => ({}));
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    transport: {
      snapshot: {
        get: () => snap,
        subscribe: (l: () => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
      notify,
      request,
      on: (type: string, handler: (payload: unknown) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    },
    notify,
    request,
    handlers,
    set(next: FakeSnapshot) {
      snap = next;
      for (const l of [...listeners]) l();
    },
  };
}

/** A fetch that records every call and answers each route from a table. */
function fakeFetch(routes: Record<string, unknown>, status = 200) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body == null ? null : JSON.parse(String(init.body)),
      auth: headers.get('Authorization'),
    });
    const key = Object.keys(routes).find((route) => url.includes(route));
    const payload = key === undefined ? { error: `no fake route for ${url}` } : routes[key];
    return new Response(JSON.stringify(payload), {
      status: key === undefined ? 404 : status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

afterEach(() => {
  resetSdkRuntime();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// group 1 — the snapshot
// ---------------------------------------------------------------------------

describe('group 1: snapshot bindings', () => {
  function Probe() {
    const { ready, viewer, theme } = useBlockContext();
    const host = useHostOrigin();
    const renders = useRef(0);
    renders.current += 1;
    return (
      <div>
        <span data-testid="ready">{String(ready)}</span>
        <span data-testid="viewer">{viewer?.username ?? 'anon'}</span>
        <span data-testid="theme">{theme}</span>
        <span data-testid="host">{host ?? 'none'}</span>
        <span data-testid="renders">{renders.current}</span>
      </div>
    );
  }

  it('reads ready / viewer / theme / hostOrigin off the transport snapshot', () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    render(<Probe />);

    expect(screen.getByTestId('ready').textContent).toBe('true');
    expect(screen.getByTestId('viewer').textContent).toBe('zed');
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(screen.getByTestId('host').textContent).toBe('https://civitai.com');
  });

  it('re-renders when the snapshot changes, and SETTLES rather than looping', async () => {
    const t = fakeTransport(baseSnapshot({ ready: false, theme: 'light', hostOrigin: null }));
    configureSdkRuntime({ transport: t.transport as never });

    render(<Probe />);
    expect(screen.getByTestId('ready').textContent).toBe('false');
    expect(screen.getByTestId('host').textContent).toBe('none');

    const before = Number(screen.getByTestId('renders').textContent);
    act(() => t.set(baseSnapshot()));

    expect(screen.getByTestId('ready').textContent).toBe('true');
    expect(screen.getByTestId('theme').textContent).toBe('dark');

    // 🔴 THE LOOP GUARD, AND THE REASON IT IS A RANGE RATHER THAN AN EQUALITY.
    // A selector that composed a fresh object would never compare `Object.is`-equal,
    // so React would re-render on every commit and this count would run away. The
    // assertion needs a ceiling loose enough to survive StrictMode double-invokes
    // and tight enough that a runaway (hundreds) fails. Settling is the claim.
    const after = Number(screen.getByTestId('renders').textContent);
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThan(6);
  });

  it('maps a null hostOrigin to undefined and INVENTS NO FALLBACK', () => {
    const t = fakeTransport(baseSnapshot({ hostOrigin: null }));
    configureSdkRuntime({ transport: t.transport as never });

    render(<Probe />);

    // 🔴 THE SECURITY ASSERTION, and the mirror of the adapter suite's MUTANT B.
    // `hostOrigin` becomes the base URL a money-scoped bearer token is sent to, so
    // a not-ready state must stay empty. `window.location.origin` under jsdom is
    // `http://localhost:3000` — if anything ever substitutes it, this reads it back
    // instead of 'none' and fails by name.
    expect(screen.getByTestId('host').textContent).toBe('none');
    expect(screen.getByTestId('host').textContent).not.toContain('localhost');
  });

  it('exposes the raw domain and per-viewer browsing ceilings separately', () => {
    const t = fakeTransport(baseSnapshot({ maxBrowsingLevel: 31, effectiveBrowsingLevel: 3 }));
    configureSdkRuntime({ transport: t.transport as never });

    function Levels() {
      const { max, effective } = useBrowsingLevels();
      return <span data-testid="levels">{`${max}/${effective}`}</span>;
    }
    render(<Levels />);

    // Both, unintersected — the intersection is `viewer-maturity.ts`'s job, and
    // this binding must not pre-empt it or that module could not be tested.
    expect(screen.getByTestId('levels').textContent).toBe('31/3');
  });

  it('token.refresh() asks the host for a FRESH mint rather than reading the snapshot', async () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    let refresh: (() => Promise<void>) | null = null;
    function TokenProbe() {
      const token = useBlockToken();
      refresh = token.refresh;
      return <span data-testid="raw">{token.raw}</span>;
    }
    render(<TokenProbe />);
    expect(screen.getByTestId('raw').textContent).toBe('jwt-1');

    // The SDK's host session answers a fresh mint from a REQUEST_TOKEN round trip
    // through the transport — the one request type the adapter maps.
    t.request.mockResolvedValueOnce({
      token: { raw: 'jwt-2', scopes: [], expiresAt: new Date('2030-01-01').toISOString() },
    });
    await act(async () => {
      await refresh!();
    });

    expect(t.request).toHaveBeenCalledWith('REQUEST_TOKEN', { blockInstanceId: 'inst-1' }, expect.anything());
  });
});

// ---------------------------------------------------------------------------
// group 2 — host-mediated
// ---------------------------------------------------------------------------

describe('group 2: host-mediated bindings', () => {
  /**
   * A minimal ResizeObserver, because jsdom has none.
   *
   * 🔴 WITHOUT THIS THE TEST PROVED THE OPPOSITE OF WHAT IT CLAIMED. Both the SDK's
   * `autoResize` and the bridge hook it replaces bail out when `ResizeObserver` is
   * undefined, so under bare jsdom the code path never runs and a "reports a height"
   * assertion fails while the production path is fine — a fixture problem reading as
   * a defect. Stubbing it means this exercises the REAL branch.
   */
  function stubResizeObserver() {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    class RO {
      observe(el: Element) {
        observed.push(el);
      }
      disconnect = disconnect;
    }
    const prior = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO as unknown as typeof ResizeObserver;
    return {
      observed,
      disconnect,
      restore: () => {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = prior;
      },
    };
  }

  it('useBlockResize reports a height on mount and disconnects on unmount', () => {
    const ro = stubResizeObserver();
    try {
      const t = fakeTransport();
      configureSdkRuntime({ transport: t.transport as never });

      function Resizer() {
        const ref = useRef<HTMLDivElement>(null);
        useBlockResize(ref);
        return <div ref={ref}>content</div>;
      }
      const view = render(<Resizer />);

      // `autoResize` reports once immediately after observing (`report()` at the end
      // of its own setup), which the bridge hook did NOT do — it only reported from
      // observer callbacks. Asserted rather than glossed: it is a behaviour the port
      // gains, and an initial report is strictly better for a block whose first paint
      // is taller than the host's default iframe height.
      const resizes = t.notify.mock.calls.filter(([msg]) => msg.type === 'RESIZE_IFRAME');
      expect(resizes.length).toBe(1);
      expect(ro.observed.length).toBe(1);

      view.unmount();
      // The effect must RETURN the host client's teardown; a hook that swallowed it
      // would leave the observer attached to a detached node for the page's life.
      expect(ro.disconnect).toHaveBeenCalled();
    } finally {
      ro.restore();
    }
  });

  it('useBlockResize is a safe no-op where ResizeObserver does not exist', () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    function Resizer() {
      const ref = useRef<HTMLDivElement>(null);
      useBlockResize(ref);
      return <div ref={ref}>content</div>;
    }
    // jsdom ships none, so this is the unstubbed environment. No message, no throw —
    // the same degradation the bridge hook had, kept rather than silently changed.
    const view = render(<Resizer />);
    expect(t.notify.mock.calls.filter(([msg]) => msg.type === 'RESIZE_IFRAME')).toHaveLength(0);
    expect(() => view.unmount()).not.toThrow();
  });

  it('useRequestSignIn notifies the host', () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    function SignIn() {
      const { requestSignIn } = useRequestSignIn();
      useEffect(() => requestSignIn(), [requestSignIn]);
      return null;
    }
    render(<SignIn />);

    expect(t.notify.mock.calls.some(([msg]) => msg.type === 'REQUEST_SIGN_IN')).toBe(true);
  });

  it('useRequestConsent is FIRE-AND-FORGET and swallows an abandoned dialog', async () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });

    const unhandled = vi.fn();
    globalThis.addEventListener('unhandledrejection', unhandled);
    try {
      function Consent() {
        const { requestConsent } = useRequestConsent();
        useEffect(() => requestConsent({ scopes: ['collections:read:private'] }), [requestConsent]);
        return null;
      }
      render(<Consent />);

      // The request goes out as a notify, and the call site never awaited it.
      await waitFor(() =>
        expect(
          t.notify.mock.calls.some(
            ([msg]) =>
              msg.type === 'REQUEST_CONSENT' &&
              (msg.payload as { scopes: string[] }).scopes.includes('collections:read:private'),
          ),
        ).toBe(true),
      );

      // 🔴 THE VIEWER WHO CLOSES THE DIALOG SENDS NOTHING. `requestGrants` then
      // resolves neither way, so the only observable is that nothing rejected into
      // the page. A missing `.catch()` here surfaces as a console error a viewer
      // can produce at will.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      globalThis.removeEventListener('unhandledrejection', unhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// group 3 — REST
// ---------------------------------------------------------------------------

describe('group 3: REST bindings — the wire, not a stub', () => {
  let t: ReturnType<typeof fakeTransport>;

  beforeEach(() => {
    t = fakeTransport();
  });

  it('useBuzzBalance GETs blocks/buzz and returns the BARE three pools', async () => {
    const f = fakeFetch({ 'blocks/buzz': { blue: 1, green: 2, yellow: 3 } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    function Balance() {
      const { balance, loading } = useBuzzBalance();
      return <span data-testid="b">{loading ? 'loading' : JSON.stringify(balance)}</span>;
    }
    render(<Balance />);

    await waitFor(() =>
      expect(screen.getByTestId('b').textContent).toBe(JSON.stringify({ blue: 1, green: 2, yellow: 3 })),
    );

    const call = f.calls.find((c) => c.url.includes('blocks/buzz'));
    // The route, the method and the bearer — each asserted, because each is a way
    // this can be wrong while still "returning a balance" against a lenient fake.
    expect(call).toBeDefined();
    expect(call!.method).toBe('GET');
    expect(call!.auth).toBe('Bearer jwt-1');
  });

  it('useBuzzBalance refetch re-reads the route', async () => {
    const f = fakeFetch({ 'blocks/buzz': { blue: 0, green: 0, yellow: 5 } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    let refetch: (() => void) | null = null;
    function Balance() {
      const b = useBuzzBalance();
      refetch = b.refetch;
      return <span data-testid="b">{b.balance?.yellow ?? -1}</span>;
    }
    render(<Balance />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('5'));

    const before = f.calls.filter((c) => c.url.includes('blocks/buzz')).length;
    await act(async () => {
      refetch!();
    });
    await waitFor(() =>
      expect(f.calls.filter((c) => c.url.includes('blocks/buzz')).length).toBe(before + 1),
    );
  });

  it('useBuzzBalance surfaces a failure as an error rather than a zero balance', async () => {
    const f = fakeFetch({ 'blocks/buzz': { error: 'Forbidden' } }, 403);
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    function Balance() {
      const { balance, error } = useBuzzBalance();
      return <span data-testid="b">{error ? 'error' : JSON.stringify(balance)}</span>;
    }
    render(<Balance />);

    // 🔴 `null`, NEVER `{0,0,0}`. The balance feeds the tip modal's soft ceiling,
    // so a zero reads to a viewer as "you have no Buzz" — a refusal must not be
    // dressed up as an answer. `scopes.ts` records the same rule for the missing
    // `buzz:read:self` case.
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('error'));
  });

  it('useSharedStorage.vote POSTs the verified route and returns the new count', async () => {
    const f = fakeFetch({ 'shared-storage/vote': { count: 12 } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    let vote: ((key: string) => Promise<number>) | null = null;
    function Voter() {
      const shared = useSharedStorage();
      vote = shared.vote;
      return null;
    }
    render(<Voter />);

    const count = await vote!('row-9');
    expect(count).toBe(12);

    const call = f.calls.find((c) => c.url.includes('shared-storage/vote'));
    expect(call).toBeDefined();
    // 🔴 PINNED AGAINST THE ROUTE FILE, not against what the SDK happens to send:
    // civitai `src/pages/api/v1/blocks/shared-storage/vote.ts` is POST, body
    // `{ key }`, reply `{ count }`. This is app-layer precisely because
    // `starters#479` kept vote OUT of `AppClient.sharedStorage`, so nothing in the
    // SDK will fail if this drifts — which is why the assertion lives here.
    expect(call!.method).toBe('POST');
    expect(call!.body).toEqual({ key: 'row-9' });
    expect(call!.url).toContain('/blocks/shared-storage/vote');
  });

  it('useSharedStorage.vote THROWS on a reply carrying no numeric count', async () => {
    const f = fakeFetch({ 'shared-storage/vote': { ok: true } });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    let vote: ((key: string) => Promise<number>) | null = null;
    function Voter() {
      vote = useSharedStorage().vote;
      return null;
    }
    render(<Voter />);

    // 🔴 THE `?? 0` REGRESSION. `recordPlay` writes this number into the popular
    // rail, so coercing a malformed reply to 0 would publish a play count of zero
    // and rank on it. A failure must reject.
    await expect(vote!('row-9')).rejects.toThrow(/numeric `count`/);
  });

  it('useSharedStorage.list and .append reach the SDK client’s own routes', async () => {
    const f = fakeFetch({
      'shared-storage/list': { items: [], metadata: { nextCursor: 'c2' } },
      'shared-storage/append': { key: 'k-new' },
    });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    let shared: ReturnType<typeof useSharedStorage> | null = null;
    function S() {
      shared = useSharedStorage();
      return null;
    }
    render(<S />);

    const page = await shared!.list({ limit: 5 });
    expect(page.nextCursor).toBe('c2');
    const appended = await shared!.append({ title: 'hello' });
    expect(appended.key).toBe('k-new');

    const list = f.calls.find((c) => c.url.includes('shared-storage/list'));
    expect(list!.method).toBe('GET');
    // The cursor/limit go on the query string — the paging mutant this repo has
    // already been bitten by once (a dropped `cursor` survived a whole suite).
    expect(list!.url).toContain('limit=5');
    expect(f.calls.find((c) => c.url.includes('shared-storage/append'))!.method).toBe('POST');
  });

  it('useAppStorage reaches blocks/app-storage and keeps a STABLE identity', async () => {
    // `sizeBytes` is REQUIRED, not optional: the SDK's storage client throws
    // without it, and the route's docblock states success is always
    // `{ ok: true, sizeBytes }` with "no 2xx path that means not written". The
    // bridge hook's type had it optional — a real tightening the port inherits, and
    // the reason this fixture cannot be the thin `{ ok: true }` it started as.
    const f = fakeFetch({
      'app-storage/get': { value: { sort: 'popular' } },
      'app-storage/set': { ok: true, sizeBytes: 21 },
    });
    configureSdkRuntime({ transport: t.transport as never, fetch: f.impl });

    const seen: unknown[] = [];
    function Storage() {
      const storage = useAppStorage();
      const [, bump] = useState(0);
      seen.push(storage);
      useEffect(() => {
        bump(1);
      }, []);
      return null;
    }
    render(<Storage />);

    // 🔴 THE DEPENDENCY-ARRAY CONTRACT. `lib/browse-prefs.ts` puts this object in
    // an effect's deps; a fresh identity per render would re-run that effect
    // forever. The bridge hook documented itself as stable and this must be too.
    await waitFor(() => expect(seen.length).toBeGreaterThan(1));
    expect(new Set(seen).size).toBe(1);

    const storage = seen[0] as ReturnType<typeof useAppStorage>;
    await storage.set('browse-prefs', { sort: 'popular' });
    const call = f.calls.find((c) => c.url.includes('app-storage/set'));
    expect(call).toBeDefined();
    expect(call!.method).toBe('POST');
    expect(call!.body).toEqual({ key: 'browse-prefs', value: { sort: 'popular' } });
  });
});

// ---------------------------------------------------------------------------
// the configuration seam itself
// ---------------------------------------------------------------------------

describe('configureSdkRuntime', () => {
  /**
   * 🔴 A RECONFIGURE MUST TAKE EFFECT, AND THIS IS THE ASSERTION THAT REPLACED A
   * WEAKER ONE. This test used to assert that a second `configureSdkRuntime` THREW,
   * because a swapped `fetch` would otherwise be silently ignored. The refusal was
   * the wrong remedy — it also rejected a legitimate case in this repo's suite (a
   * test rendering the app twice with different props) — so the function now drops
   * the AppClient instead. That turns an error message into a testable behaviour:
   * the SECOND fetch is the one that gets used.
   */
  it('a reconfigure DROPS the client, so the new fetch is the one that answers', async () => {
    const t = fakeTransport();
    const first = fakeFetch({ 'blocks/buzz': { blue: 0, green: 0, yellow: 1 } });
    configureSdkRuntime({ transport: t.transport as never, fetch: first.impl });

    function Balance() {
      const { balance } = useBuzzBalance();
      return <span data-testid="b">{balance?.yellow ?? -1}</span>;
    }
    const one = render(<Balance />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('1'));
    one.unmount();

    const second = fakeFetch({ 'blocks/buzz': { blue: 0, green: 0, yellow: 2 } });
    configureSdkRuntime({ transport: t.transport as never, fetch: second.impl });

    render(<Balance />);
    // Reads 2 only if the client was rebuilt on the new fetch. Under a
    // configure that kept the old promise this stays 1 — the stale-client hazard
    // the old throwing guard could only complain about.
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('2'));
    expect(second.calls.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE REGRESSION GUARD FOR THIS REPO'S OWN TEST SETUP, and the first version
   * of it was VACUOUS — recorded here because the reason generalises.
   *
   * `src/test-setup.ts` calls `resetHarnessTransport()` in a global `beforeEach`,
   * which NULLS the bridge's process-wide transport so the next `getTransport()`
   * builds a new object. A runtime caching its adapter with a plain `??=` would keep
   * wrapping the DISPOSED transport, and every later test in the process would read
   * a dead snapshot with nothing saying so.
   *
   * 🔴 THE FIRST ATTEMPT ASSERTED "re-rendering does not throw" AND THE UNKEYED-CACHE
   * MUTANT SURVIVED IT. `dispose()` only drops listeners — `getSnapshot()` on a
   * disposed transport still answers with its last value — so "does not throw" is no
   * discriminator at all, and neither is `ready`, which is already `true` on the old
   * transport by then. The observable has to be a field whose value DIFFERS between
   * the two transports. So: anonymous on the first, signed-in on the second. Under
   * the unkeyed cache the second render reads transport #1 and reports 'anon'.
   */
  it('follows the bridge transport across a resetTransport()', async () => {
    const { installHarnessTransport, resetHarnessTransport } = await import('../dev-transport.js');
    const { getTransport } = await import('@civitai/blocks-react');
    const { Harness } = await import('@civitai/blocks-react/testing');

    function Probe() {
      const { viewer } = useBlockContext();
      return <span data-testid="who">{viewer?.username ?? 'anon'}</span>;
    }

    installHarnessTransport();
    const first = getTransport();
    configureSdkRuntime({});

    const one = render(
      <Harness viewer={null} applyUrlToggles={false} showLog={false}>
        <Probe />
      </Harness>,
    );
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('anon'));
    one.unmount();

    resetHarnessTransport();
    // The premise the guard rests on. Without this the test could not tell a keyed
    // cache from an unkeyed one and would pass either way.
    expect(getTransport()).not.toBe(first);

    render(
      <Harness viewer={{ id: 42, username: 'porter' }} applyUrlToggles={false} showLog={false}>
        <Probe />
      </Harness>,
    );

    // Reads the NEW transport, or it does not read the port at all.
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('porter'));
  });

  it('resetSdkRuntime lets a second configure through', () => {
    const t = fakeTransport();
    configureSdkRuntime({ transport: t.transport as never });
    resetSdkRuntime();
    expect(() => configureSdkRuntime({ transport: t.transport as never })).not.toThrow();
  });
});
