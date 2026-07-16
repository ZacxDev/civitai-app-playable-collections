import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import type { ViewerInfo } from '@civitai/app-sdk/blocks';

import { App } from './App.js';
import { CollectionGrid } from './components/CollectionGrid.js';
import { ApiError, type ApiClient } from './lib/api.js';
import { createFakeApi } from './fake-api.js';
import { palette } from './theme.js';
import type { CollectionSummary, MediaItem } from './types.js';
import { flushIntersections, setViewport } from './test-setup.js';

function renderApp(
  opts: {
    api?: ApiClient;
    viewer?: ViewerInfo | null;
    theme?: 'light' | 'dark';
    isPrivateGranted?: (scopes: string[]) => boolean;
    onOutbound?: (msg: { type: string; payload?: unknown }) => void;
    retry?: { retries: number; delayMs: number };
    /** Seed the mock host's per-pool Buzz wallet (GET_BUZZ_BALANCE bridge). */
    buzzBalance?: { blue: number; green: number; yellow: number };
    /** Seed the mock host's SHARED store (the apps:storage:shared:* bridge). */
    shared?: { seed?: Array<{ value: { title: string; body?: string; data?: unknown }; authorUserId?: number; voters?: number[] }> };
  } = {},
) {
  return render(
    <Harness
      viewer={opts.viewer === undefined ? { id: 99, username: 'me' } : opts.viewer}
      theme={opts.theme ?? 'dark'}
      showLog={false}
      onOutbound={opts.onOutbound}
      buzzBalance={opts.buzzBalance}
      shared={opts.shared}
    >
      <App api={opts.api} isPrivateGranted={opts.isPrivateGranted} retry={opts.retry} />
    </Harness>,
  );
}

const c = palette(true);

const sampleCollection = (over: Partial<CollectionSummary> = {}): CollectionSummary => ({
  id: 1,
  name: 'Sample',
  description: null,
  coverImageUrl: null,
  itemCount: 3,
  curator: { userId: 5, username: 'curator' },
  isPublic: true,
  followed: false,
  ...over,
});

describe('CollectionGrid states (deterministic)', () => {
  it('renders a loading state', () => {
    render(<CollectionGrid collections={[]} loading error={null} emptyLabel="none" onOpen={() => {}} c={c} isMobile={false} />);
    expect(screen.getByTestId('grid-loading')).toBeInTheDocument();
  });

  it('renders an error state with a retry button', async () => {
    const onRetry = vi.fn();
    render(
      <CollectionGrid collections={[]} loading={false} error="Boom" emptyLabel="none" onOpen={() => {}} onRetry={onRetry} c={c} isMobile={false} />,
    );
    expect(screen.getByTestId('grid-error')).toHaveTextContent('Boom');
    await userEvent.click(screen.getByTestId('grid-retry'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders an empty state', () => {
    render(<CollectionGrid collections={[]} loading={false} error={null} emptyLabel="Nothing here" onOpen={() => {}} c={c} isMobile={false} />);
    expect(screen.getByTestId('grid-empty')).toHaveTextContent('Nothing here');
  });

  it('renders cards and fires onOpen', async () => {
    const onOpen = vi.fn();
    render(
      <CollectionGrid collections={[sampleCollection({ name: 'Neon' })]} loading={false} error={null} emptyLabel="" onOpen={onOpen} c={c} isMobile={false} />,
    );
    await userEvent.click(screen.getByTestId('collection-card'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'Neon' }));
  });

  it('branches its layout on isMobile', () => {
    const { rerender } = render(
      <CollectionGrid collections={[sampleCollection()]} loading={false} error={null} emptyLabel="" onOpen={() => {}} c={c} isMobile />,
    );
    expect(screen.getByTestId('collection-grid')).toHaveAttribute('data-layout', 'mobile');
    rerender(
      <CollectionGrid collections={[sampleCollection()]} loading={false} error={null} emptyLabel="" onOpen={() => {}} c={c} isMobile={false} />,
    );
    expect(screen.getByTestId('collection-grid')).toHaveAttribute('data-layout', 'desktop');
  });

  it('shows private + followed badges', () => {
    render(
      <CollectionGrid
        collections={[sampleCollection({ isPublic: false, followed: true })]}
        loading={false}
        error={null}
        emptyLabel=""
        onOpen={() => {}}
        c={c}
        isMobile={false}
      />,
    );
    expect(screen.getByTestId('private-badge')).toBeInTheDocument();
    expect(screen.getByTestId('followed-badge')).toBeInTheDocument();
  });
});

describe('App — discover + tabs', () => {
  it('loads and shows public collections on the discover tab', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api });
    // discover shows the 3 public seed collections (2 others + own public board)
    const grid = await screen.findByTestId('collection-grid');
    const cards = within(grid).getAllByTestId('collection-card');
    expect(cards).toHaveLength(3);
    expect(grid).toHaveTextContent('Neon Cities');
    expect(grid).toHaveTextContent('Forest Studies');
    expect(grid).toHaveTextContent('My Public Board');
  });

  it('shows the viewer Buzz balance once loaded (summed from the useBuzzBalance host bridge)', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    // Balance now comes from the host-mediated GET_BUZZ_BALANCE bridge (per-pool),
    // NOT the block HTTP client. The pill shows the summed spendable figure.
    renderApp({ api, buzzBalance: { blue: 1000, green: 34, yellow: 200 } });
    await waitFor(() => expect(screen.getByTestId('buzz-balance')).toHaveTextContent('1,234'));
  });

  it('offers a Popular ↔ Newest sort toggle, defaulting to Popular labelled "Most followed" (feedback #3)', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api });
    await screen.findByTestId('collection-grid');
    const popular = screen.getByTestId('sort-popular');
    const newest = screen.getByTestId('sort-newest');
    // Two explicit options, no <select>, no name-sort.
    expect(popular).toBeInTheDocument();
    expect(newest).toBeInTheDocument();
    expect(screen.queryByTestId('sort-select')).toBeNull();
    expect(screen.queryByText('Name')).toBeNull();
    // Default = Popular, and it's labelled so users know what it means.
    expect(popular).toHaveAttribute('aria-pressed', 'true');
    expect(newest).toHaveAttribute('aria-pressed', 'false');
    expect(popular).toHaveAttribute('title', 'Most followed');
    expect(screen.getByTestId('sort-hint')).toHaveTextContent('Most followed');
  });

  it('toggling the sort re-fetches the list from page 1 with the new sort (feedback #3)', async () => {
    const base = createFakeApi({ viewerUserId: 99 });
    const seen: Array<{ sort?: string; cursor?: string }> = [];
    const api: ApiClient = {
      ...base,
      async listCollections(params) {
        if (params.mode === 'public') seen.push({ sort: params.sort, cursor: params.cursor });
        return base.listCollections(params);
      },
    };
    renderApp({ api });
    await screen.findByTestId('collection-grid');
    // Initial load used the default popular sort.
    await waitFor(() => expect(seen.some((s) => s.sort === 'popular')).toBe(true));
    seen.length = 0;

    await userEvent.click(screen.getByTestId('sort-newest'));
    // A fresh page-1 fetch (no cursor) with sort=newest.
    await waitFor(() => expect(seen.some((s) => s.sort === 'newest')).toBe(true));
    expect(seen.every((s) => s.cursor === undefined)).toBe(true);
    expect(screen.getByTestId('sort-newest')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('sort-hint')).toHaveTextContent('Newest first');
  });

  it('switches to My collections and shows own public + private when private access is granted', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api, isPrivateGranted: () => true });
    await screen.findByTestId('collection-grid');
    await userEvent.click(screen.getByTestId('tab-mine'));
    const grid = await screen.findByTestId('collection-grid');
    await waitFor(() => expect(within(grid).getAllByTestId('collection-card')).toHaveLength(2));
    expect(grid).toHaveTextContent('My Public Board');
    expect(grid).toHaveTextContent('My Private Board');
    // granted => no consent affordance
    expect(screen.queryByTestId('private-consent')).not.toBeInTheDocument();
  });

  it('prompts sign-in on My collections when anonymous', async () => {
    const api = createFakeApi();
    renderApp({ api, viewer: null });
    await screen.findByTestId('collection-grid');
    await userEvent.click(screen.getByTestId('tab-mine'));
    expect(await screen.findByTestId('mine-anon')).toBeInTheDocument();
  });

  it('surfaces a list error with retry', async () => {
    const base = createFakeApi();
    let fail = true;
    const api: ApiClient = {
      ...base,
      async listCollections(params) {
        if (params.mode === 'public' && fail) throw new ApiError('forbidden', 403, 'No access');
        return base.listCollections(params);
      },
    };
    renderApp({ api });
    expect(await screen.findByTestId('grid-error')).toHaveTextContent('No access');
    fail = false;
    await userEvent.click(screen.getByTestId('grid-retry'));
    await screen.findByTestId('collection-grid');
  });
});

describe('App — infinite scroll (feedback #1)', () => {
  /** A public list that serves 2 pages; the 2nd re-emits an id (inclusive cursor). */
  function paginatedApi() {
    const base = createFakeApi({ viewerUserId: 99 });
    const mk = (id: number): CollectionSummary => sampleCollection({ id, name: `Col ${id}` });
    // Page 0 → ids 1,2,3 (nextCursor "1"); Page 1 (cursor "1") → ids 3,4,5 (dup 3).
    const pages = [
      { items: [mk(1), mk(2), mk(3)], nextCursor: '1' as string | undefined },
      { items: [mk(3), mk(4), mk(5)], nextCursor: undefined as string | undefined },
    ];
    const api: ApiClient = {
      ...base,
      async listCollections(params) {
        if (params.mode !== 'public') return { items: [] };
        const idx = params.cursor ? Number(params.cursor) : 0;
        const page = pages[idx] ?? { items: [], nextCursor: undefined };
        return { items: page.items, nextCursor: page.nextCursor };
      },
    };
    return api;
  }

  it('appends the next page on sentinel intersection and dedupes the re-emitted id', async () => {
    renderApp({ api: paginatedApi() });
    const grid = await screen.findByTestId('collection-grid');
    expect(within(grid).getAllByTestId('collection-card')).toHaveLength(3);
    // More pages exist → the sentinel is present.
    expect(screen.getByTestId('grid-sentinel')).toBeInTheDocument();

    // Sentinel scrolls into view → fetch + append page 2 (dedupe id 3 → 5 total).
    await act(async () => {
      flushIntersections(true);
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('collection-grid')).getAllByTestId('collection-card')).toHaveLength(5),
    );
    // Fully loaded → the sentinel is gone (no unbounded scroll fetch).
    expect(screen.queryByTestId('grid-sentinel')).toBeNull();
  });
});

describe('App — detail lazy load (feedback #2)', () => {
  const mediaItem = (mediaId: number): MediaItem => ({
    mediaId,
    type: 'image',
    url: `i/${mediaId}`,
    width: 1,
    height: 1,
    creator: { userId: 11, username: 'alice' },
    nsfwLevel: 1,
  });

  function bigDetailApi() {
    const base = createFakeApi({ viewerUserId: 99 });
    const detail = {
      id: 101,
      name: 'Big',
      description: null,
      curator: { userId: 11, username: 'alice' },
      isPublic: true,
      followed: false,
    };
    const page1 = Array.from({ length: 30 }, (_, i) => mediaItem(i + 1));
    const page2 = Array.from({ length: 10 }, (_, i) => mediaItem(100 + i));
    const calls: Array<{ cursor?: string }> = [];
    const api: ApiClient = {
      ...base,
      async listCollections() {
        return { items: [sampleCollection({ id: 101, name: 'Big', curator: { userId: 11, username: 'alice' } })] };
      },
      async getCollection(_id, opts) {
        calls.push({ cursor: opts?.cursor });
        if (!opts?.cursor) return { collection: detail, items: page1, nextCursor: 'p2' };
        return { collection: detail, items: page2, nextCursor: undefined };
      },
    };
    return { api, calls };
  }

  it('opens with EXACTLY ONE fetch, then streams the next page as the player nears the tail', async () => {
    const { api, calls } = bigDetailApi();
    renderApp({ api });
    const grid = await screen.findByTestId('collection-grid');
    await userEvent.click(within(grid).getByTestId('collection-card'));
    await screen.findByTestId('player');

    // ONE getCollection on open even though a nextCursor exists — the rest is lazy.
    expect(calls).toHaveLength(1);
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 30');

    // Seek to within LOAD_AHEAD of the tail → the next page streams in.
    fireEvent.change(screen.getByTestId('scrubber'), { target: { value: '27' } });
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('28 / 40'));
  });
});

describe('App — responsive root branch', () => {
  it('marks the root layout mobile vs desktop', async () => {
    setViewport('mobile');
    const api = createFakeApi();
    const { unmount } = renderApp({ api });
    await screen.findByTestId('collection-grid');
    expect(document.querySelector('[data-layout="mobile"]')).toBeTruthy();
    unmount();

    setViewport('desktop');
    renderApp({ api: createFakeApi() });
    await screen.findByTestId('collection-grid');
    expect(document.querySelector('[data-layout="desktop"]')).toBeTruthy();
  });
});

describe('App — private collections consent gate', () => {
  async function gotoMine() {
    await screen.findByTestId('collection-grid');
    await userEvent.click(screen.getByTestId('tab-mine'));
    // wait for the mine list to load (public own board present)
    await screen.findByText('My Public Board');
  }

  it('hides private collections and shows the consent affordance when not granted', async () => {
    // Default App predicate keys off the REAL scope, which the mock host never
    // grants — models "not yet granted". Fake mirrors the server: private hidden.
    const api = createFakeApi({ viewerUserId: 99, collectionsPrivateGranted: () => false });
    renderApp({ api }); // no isPrivateGranted override
    await gotoMine();

    expect(screen.getByTestId('private-consent')).toBeInTheDocument();
    expect(screen.getByText('My Public Board')).toBeInTheDocument();
    expect(screen.queryByText('My Private Board')).not.toBeInTheDocument();
    // graceful: no error surface
    expect(screen.queryByTestId('grid-error')).not.toBeInTheDocument();
  });

  it('the affordance sends a REQUEST_CONSENT for collections:read:private (declined path stays public-only, no error)', async () => {
    const outbound: Array<{ type: string; payload?: unknown }> = [];
    const api = createFakeApi({ viewerUserId: 99, collectionsPrivateGranted: () => false });
    // Default predicate => the mock host's grant (ai:write:budgeted) does NOT map
    // to the private scope, so this models the host NOT granting (decline).
    renderApp({ api, onOutbound: (m) => outbound.push(m) });
    await gotoMine();

    await userEvent.click(screen.getByTestId('enable-private'));

    const consentMsg = outbound.find((m) => m.type === 'REQUEST_CONSENT');
    expect(consentMsg).toBeTruthy();
    expect(consentMsg?.payload).toMatchObject({ scopes: ['collections:read:private'] });

    // Declined / not granted: private still hidden, affordance persists, no error.
    await waitFor(() => expect(screen.getByTestId('private-consent')).toBeInTheDocument());
    expect(screen.queryByText('My Private Board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('grid-error')).not.toBeInTheDocument();
  });

  it('after grant + token re-mint, private collections appear and the affordance disappears', async () => {
    // The mock host grants `ai:write:budgeted` on REQUEST_CONSENT and re-mints
    // the token (TOKEN_REFRESH). We map that grant to the private scope, and flip
    // the fake server to reveal private on the same consent event — a true
    // request -> re-mint -> observe -> reload round-trip.
    let granted = false;
    const api = createFakeApi({ viewerUserId: 99, collectionsPrivateGranted: () => granted });
    renderApp({
      api,
      isPrivateGranted: (scopes) => scopes.includes('ai:write:budgeted'),
      onOutbound: (m) => {
        if (m.type === 'REQUEST_CONSENT') granted = true;
      },
    });
    await gotoMine();

    // before consent: private hidden, affordance shown
    expect(screen.getByTestId('private-consent')).toBeInTheDocument();
    expect(screen.queryByText('My Private Board')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('enable-private'));

    // after grant + re-mint: private appears, affordance gone
    expect(await screen.findByText('My Private Board')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('private-consent')).not.toBeInTheDocument());
    expect(screen.getByText('My Public Board')).toBeInTheDocument();
  });
});

// --------------------------------------------------------------------------
// Host-origin gating + bounded retry (the run-page infinite-loop fix)
// --------------------------------------------------------------------------

/** A fetch stub that records request URLs and returns per-URL canned responses. */
function stubFetch(respond: (url: string) => Response) {
  const urls: string[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return respond(url);
  });
  vi.stubGlobal('fetch', spy);
  return { urls, spy };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('App — host-origin gating (real HTTP client)', () => {
  it('does NOT create a client or fetch before the host origin is established', () => {
    const { spy } = stubFetch(() => json({ items: [] }));
    // No Harness => no BLOCK_INIT => useHostOrigin() is undefined and ready=false.
    render(<App />);
    expect(screen.getByText(/Loading Playable Collections/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('once useHostOrigin returns, fetches ABSOLUTE URLs against the validated host (not same-origin)', async () => {
    const host = window.location.origin;
    const { urls } = stubFetch((url) => {
      // Buzz + shared play-counts no longer touch the HTTP client (they go via
      // the postMessage bridge), so collections is the only fetch the app makes.
      if (url.includes('/blocks/collections')) return json({ items: [] });
      return json({});
    });
    renderApp(); // no injected api => the real HTTP client path
    // empty items => the grid renders its empty state; wait for the fetch to land
    await screen.findByTestId('grid-empty');

    const collectionsCall = urls.find((u) => u.includes('/blocks/collections'));
    expect(collectionsCall).toBeDefined();
    // Absolute, against the validated host origin — NOT a same-origin relative path.
    expect(collectionsCall!.startsWith(`${host}/api/v1/blocks/collections`)).toBe(true);
    expect(collectionsCall!.startsWith('/api')).toBe(false);
  });
});

describe('App — bounded retry / no infinite loop', () => {
  it('a non-JSON (HTML) response lands in the error state after ONE attempt, not a loop', async () => {
    const host = window.location.origin;
    const collectionsCalls: string[] = [];
    stubFetch((url) => {
      if (url.includes('/blocks/collections')) {
        collectionsCalls.push(url);
        // The exact bug: a same-origin SPA index.html served with 200.
        return new Response('<!doctype html><html><body>app</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return json({ items: [] });
    });
    renderApp(); // real client path against `host`
    // Parse error is NON-retryable => error surfaces, bounded to a single call.
    expect(await screen.findByTestId('grid-error')).toBeInTheDocument();
    expect(collectionsCalls).toHaveLength(1);
    expect(host).toBeTruthy();
  });

  it('a persistent 500 surfaces the error after a BOUNDED number of attempts (no loop)', async () => {
    const base = createFakeApi();
    const listSpy = vi.fn(async () => {
      throw new ApiError('unknown', 500, 'server exploded');
    });
    const api: ApiClient = { ...base, listCollections: listSpy };
    // retries: 2 => at most 3 attempts, delay 0 for a fast deterministic run.
    renderApp({ api, retry: { retries: 2, delayMs: 0 } });
    expect(await screen.findByTestId('grid-error')).toBeInTheDocument();
    // BOUNDED: exactly 1 + 2 retries. If it looped, this would be huge.
    expect(listSpy).toHaveBeenCalledTimes(3);
  });

  it('the manual retry button re-attempts after the bounded failure', async () => {
    const base = createFakeApi();
    let fail = true;
    const listSpy = vi.fn(async (params: Parameters<ApiClient['listCollections']>[0]) => {
      if (fail) throw new ApiError('unknown', 500, 'boom');
      return base.listCollections(params);
    });
    const api: ApiClient = { ...base, listCollections: listSpy };
    renderApp({ api, retry: { retries: 1, delayMs: 0 } });
    await screen.findByTestId('grid-error');
    expect(listSpy).toHaveBeenCalledTimes(2); // 1 + 1 retry, bounded
    fail = false;
    await userEvent.click(screen.getByTestId('grid-retry'));
    await screen.findByTestId('collection-grid');
  });
});
