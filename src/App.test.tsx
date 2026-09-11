import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    isTipGranted?: (scopes: string[]) => boolean;
    onOutbound?: (msg: { type: string; payload?: unknown }) => void;
    retry?: { retries: number; delayMs: number };
    /** Seed the mock host's per-pool Buzz wallet (GET_BUZZ_BALANCE bridge). */
    buzzBalance?: { blue: number; green: number; yellow: number };
    /** Seed the mock host's SHARED store (the apps:storage:shared:* bridge). */
    shared?: { seed?: Array<{ value: { title: string; body?: string; data?: unknown }; authorUserId?: number; voters?: number[] }> };
    /** Analytics sink (Feature #10). */
    onEvent?: (e: { type: string; [k: string]: unknown }) => void;
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
      {/* The Harness token carries no `social:tip:self`, so without this the T5 consent
          gate short-circuits every tip case in this file into a REQUEST_CONSENT. These
          suites are about the money MECHANICS, not about consent — the gate has its own
          red/green pair in `components/tip-affordance.test.tsx`. */}
      <App
        api={opts.api}
        isPrivateGranted={opts.isPrivateGranted}
        isTipGranted={opts.isTipGranted ?? (() => true)}
        retry={opts.retry}
        onEvent={opts.onEvent}
      />
    </Harness>,
  );
}

const c = palette();

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

  it('renders a loading SKELETON grid (not a spinner row) while first-loading (#10)', () => {
    render(<CollectionGrid collections={[]} loading error={null} emptyLabel="none" onOpen={() => {}} c={c} isMobile={false} />);
    const loading = screen.getByTestId('grid-loading');
    expect(within(loading).getAllByTestId('skeleton-card').length).toBeGreaterThan(1);
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

  // 🔴 FOUR COVER-GATE TESTS WERE DELETED FROM HERE IN 0.2.11, NOT REPOINTED.
  // They asserted `cover-gate` / `cover-reveal` — a per-cover tap-to-reveal that
  // blurred a thumbnail and let anyone click it away with no age assertion of any
  // kind. That mechanism is gone: a cover is painted iff the viewer's maturity
  // ceiling permits its rating, and an excluded one falls into the ordinary ▶
  // placeholder tile. The replacement suite lives with the component it belongs
  // to (`components/CollectionGrid.test.tsx`), which can project a ceiling; these
  // bare renders never could, so a test here could only ever have seen the
  // fail-closed arm. What remains here is the one claim this file is the right
  // place for: the grid the APP renders carries no reveal affordance.
  it('🔴 no cover on the grid offers a reveal — the deleted gate has no residue in the app shell', () => {
    render(
      <CollectionGrid
        collections={[
          sampleCollection({ id: 1, coverImageUrl: 'https://x/1.jpg', coverNsfwLevel: 8 }),
          sampleCollection({ id: 2, coverImageUrl: 'https://x/2.jpg', coverNsfwLevel: 1 }),
          sampleCollection({ id: 3, coverImageUrl: 'https://x/3.jpg', coverNsfwLevel: undefined }),
        ]}
        loading={false}
        error={null}
        emptyLabel=""
        onOpen={() => {}}
        c={c}
        isMobile={false}
      />,
    );
    // No ceiling is projected here, so it fail-closes to SFW: only the PG cover
    // paints, and the other two are placeholders. That is the positive control —
    // an assertion of "no reveal" over an empty grid would prove nothing.
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(screen.getAllByTestId('cover-placeholder')).toHaveLength(2);
    expect(screen.queryByTestId('cover-gate')).toBeNull();
    expect(screen.queryByTestId('cover-reveal')).toBeNull();
    expect(screen.queryByTestId('maturity-reveal')).toBeNull();
    expect(document.querySelector('[style*="blur("]')).toBeNull();
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

  it('LIVE type-ahead search filters the list without pressing Enter/Search (debounced, dogfood)', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api });
    const grid = await screen.findByTestId('collection-grid');
    expect(within(grid).getAllByTestId('collection-card')).toHaveLength(3);

    // Type a query — do NOT submit the form / press Enter or the Search button.
    await userEvent.type(screen.getByTestId('search-input'), 'Forest');

    // After the debounce settles, the list re-fetches with the query and filters.
    await waitFor(() => {
      const g = screen.getByTestId('collection-grid');
      expect(within(g).getAllByTestId('collection-card')).toHaveLength(1);
      expect(g).toHaveTextContent('Forest Studies');
      expect(g).not.toHaveTextContent('Neon Cities');
    });
  });

  it('does NOT render a Buzz readout in the header — the badge was removed (was: "shows the viewer Buzz balance")', async () => {
    // 🔴 REVERSED DELIBERATELY. This test used to assert the pill showed "1,234".
    // Operator decision 2026-09-05: HIDE the badges, KEEP the balance. The wallet
    // figure is still fetched and still gates a tip (see the two tests below); it
    // simply is not a permanent piece of app chrome any more.
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api, buzzBalance: { blue: 1000, green: 34, yellow: 200 } });
    // Wait for a LOADED app before asserting an absence — an assertion made while
    // the boot gate is still showing "Loading…" would pass for the wrong reason.
    await screen.findByTestId('collection-grid');
    expect(screen.queryByTestId('buzz-balance')).toBeNull();
    expect(screen.queryByTestId('viewer-buzz')).toBeNull();
    // Nor is the figure rendered under some other element.
    expect(screen.queryByText(/1,234/)).toBeNull();
  });

  it('offers a Popular ↔ Newest sort toggle, and describes the active sort as a sentence rather than a third chip', async () => {
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
    // 🔴 The `title` is GONE on purpose and this asserts its absence, not merely
    // the new text. The same string used to be delivered twice — as a native
    // tooltip on the button AND as the visible hint — so dropping one without a
    // guard would leave the duplicate free to come back.
    expect(popular).not.toHaveAttribute('title');
    // A SENTENCE, with a full stop: inline after the two chips at 12px dimmed,
    // the bare "Most followed" read as a third, disabled sort option.
    expect(screen.getByTestId('sort-hint')).toHaveTextContent('Sorted by most followed.');
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
    expect(screen.getByTestId('sort-hint')).toHaveTextContent('Sorted newest first.');
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

describe('Buzz: the readout is gone, the BALANCE is not', () => {
  // 🔴 THE HALF THAT IS EASY TO GET WRONG. Deleting the badges is one thing; the
  // hazard is deleting the balance PATH with them, which no absence-assertion can
  // see — `queryByTestId('buzz-balance') === null` passes just as happily when
  // `useBuzzBalance()` has been ripped out and every tip silently skips its
  // client-side affordability check. So each absence test below is paired with a
  // test that the figure still ARRIVES where it is spent.

  async function openFirstCollection() {
    const grid = await screen.findByTestId('collection-grid');
    await userEvent.click(within(grid).getAllByTestId('collection-card')[0]);
    await screen.findByTestId('player');
  }

  it('renders no Buzz badge anywhere in the VIEWER/PLAYER chrome either', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api, buzzBalance: { blue: 1000, green: 34, yellow: 200 } });
    await openFirstCollection();
    // Three readouts existed: App header (`buzz-balance`), the viewer toolbar
    // (`viewer-buzz`) and the player top overlay (`buzz-balance` again).
    expect(screen.queryByTestId('viewer-buzz')).toBeNull();
    expect(screen.queryByTestId('buzz-balance')).toBeNull();
    expect(screen.queryByLabelText('Your Buzz balance')).toBeNull();
    expect(screen.queryByText(/1,234/)).toBeNull();
  });

  it('🔴 still threads the balance into the tip picker — "You have 1,234 Buzz."', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api, buzzBalance: { blue: 1000, green: 34, yellow: 200 } });
    await openFirstCollection();
    await userEvent.click(screen.getByTestId('chrome-tip'));
    const modal = await screen.findByTestId('tip-split-modal');
    // The exact summed figure from the GET_BUZZ_BALANCE bridge, rendered by the
    // picker. This is the positive control for the absence assertions above.
    expect(modal).toHaveTextContent('You have 1,234 Buzz.');
  });

  it('🔴 still REJECTS a tip larger than the balance (the real figure reached the validator)', async () => {
    // The behavioural half. The line above is a string; this asserts the balance
    // actually flows into the validator and blocks a spend.
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api, buzzBalance: { blue: 100, green: 0, yellow: 0 } });
    await openFirstCollection();
    await userEvent.click(screen.getByTestId('chrome-tip'));
    const input = await screen.findByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '400');
    expect(await screen.findByTestId('split-error')).toHaveTextContent('100 Buzz balance');
    expect(screen.getByTestId('split-confirm')).toBeDisabled();
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

  it('🔴 pressing Tip WITHOUT the grant sends a REQUEST_CONSENT for BOTH money scopes — asserted on the wire', async () => {
    const outbound: Array<{ type: string; payload?: unknown }> = [];
    const api = createFakeApi({ viewerUserId: 99 });
    // `isTipGranted: () => false` models the real production default: the mint is
    // fail-closed on a missing grant row, so a first-time viewer's token carries
    // neither money scope. Measured live 2026-09-08 — consent for
    // `social:tip:self` existed on ONE row across the whole grants table.
    renderApp({ api, isTipGranted: () => false, onOutbound: (m) => outbound.push(m) });
    // Open a collection (this describe has no shared helper for it).
    const grid = await screen.findByTestId('collection-grid');
    await userEvent.click(within(grid).getAllByTestId('collection-card')[0]);
    await screen.findByTestId('player');

    // CONTROL: nothing has asked for consent before the press. Without this the
    // assertion below cannot tell "the press did it" from "something already had".
    expect(outbound.find((m) => m.type === 'REQUEST_CONSENT')).toBeUndefined();

    await userEvent.click(await screen.findByTestId('chrome-tip'));

    const consentMsg = outbound.find((m) => m.type === 'REQUEST_CONSENT');
    expect(consentMsg).toBeTruthy();
    // BOTH, and exactly these two. `social:tip:self` is what the server gates the
    // transfer on; `buzz:read:self` is what puts a balance in the picker. Asking
    // for only the first leaves a picker that can send but cannot say from what.
    expect(consentMsg?.payload).toMatchObject({
      scopes: ['social:tip:self', 'buzz:read:self'],
    });
    // And no picker: it could only end in "not sent".
    expect(screen.queryByTestId('tip-split-modal')).toBeNull();
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

describe('App — analytics events (Feature #10)', () => {
  it('emits play, mode_switch, follow and tip events', async () => {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    renderApp({ api: createFakeApi({ viewerUserId: 99, balance: 100000 }), onEvent: (e) => events.push(e) });
    const grid = await screen.findByTestId('collection-grid');
    await userEvent.click(within(grid).getAllByTestId('collection-card')[0]); // Neon Cities (101)
    await screen.findByTestId('collection-viewer');
    expect(events).toContainEqual(expect.objectContaining({ type: 'play', collectionId: 101 }));

    // Mode switch → continuous chrome.
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    expect(events).toContainEqual(expect.objectContaining({ type: 'mode_switch', collectionId: 101, mode: 'continuous-horizontal' }));

    // Follow (continuous chrome).
    await userEvent.click(screen.getByTestId('chrome-follow'));
    await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'follow', collectionId: 101, followed: true })));

    // Tip the curator, through the one affordance.
    await userEvent.click(screen.getByTestId('chrome-tip'));
    const modal = await screen.findByTestId('tip-split-modal');
    await userEvent.click(within(modal).getByTestId('tip-target-curator'));
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'tip', kind: 'curator', amount: 50 })));
  });

  it('emits popular_open when opening from the Popular rail', async () => {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    renderApp({
      api: createFakeApi({ viewerUserId: 99 }),
      onEvent: (e) => events.push(e),
      // 🔴 THREE entries, each at or above POPULAR_MIN_PLAYS — the rail is only
      // rendered when both floors are met, so a single seeded entry would hide it
      // and this test would fail for a reason unrelated to its subject.
      shared: {
        seed: [
          { value: { title: 'Neon Cities', data: { collectionId: 101 } }, voters: [1, 2] },
          { value: { title: 'Forest Studies', data: { collectionId: 102 } }, voters: [1, 2, 3] },
          // 🔴 201 ('My Public Board') — an id the fake API actually ships.
          // `resolvePopularEntries` DROPS an unresolvable id, so an invented
          // companion shrinks the set below the entry floor and hides the rail.
          { value: { title: 'My Public Board', data: { collectionId: 201 } }, voters: [1, 2, 3, 4] },
        ],
      },
    });
    await screen.findByTestId('collection-grid');
    const rail = await screen.findByTestId('popular-rail');
    // 🔴 PICKED BY IDENTITY, NOT BY POSITION. The rail needs three entries to
    // render, and it RANKS them by play count — so `[0]` is whichever companion
    // happens to be most-played, and this test asserts on collectionId 101. An
    // index here couples the assertion to a ranking that is not its subject;
    // it failed exactly that way once before this comment was written.
    const neon = within(rail)
      .getAllByTestId('popular-card')
      .find((el) => el.getAttribute('aria-label')?.includes('Neon Cities'));
    expect(neon).toBeDefined();
    await userEvent.click(neon!);
    await screen.findByTestId('collection-viewer');
    expect(events).toContainEqual(expect.objectContaining({ type: 'popular_open', collectionId: 101 }));
  });
});

describe('App — Continue-watching rail (Feature #7)', () => {
  it('lists a played collection and reopens it at the saved position', async () => {
    renderApp({ api: createFakeApi({ viewerUserId: 99 }) });
    const grid = await screen.findByTestId('collection-grid');
    await userEvent.click(within(grid).getAllByTestId('collection-card')[0]); // Neon Cities (101), 3 items
    await screen.findByTestId('collection-viewer');
    // Seek to the last item, then exit (saves mode + position).
    fireEvent.change(screen.getByTestId('scrubber'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('3 / 3'));
    await userEvent.click(screen.getByTestId('viewer-exit'));

    // Back on discover, the Continue-watching rail lists the collection.
    const rail = await screen.findByTestId('recent-rail');
    expect(rail).toHaveTextContent('Neon Cities');

    // Reopening from the rail resumes at the saved position.
    await userEvent.click(within(rail).getByTestId('recent-card'));
    await screen.findByTestId('collection-viewer');
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('3 / 3'));
  });

  it('does not show the rail before anything has been played', async () => {
    renderApp({ api: createFakeApi({ viewerUserId: 99 }) });
    await screen.findByTestId('collection-grid');
    expect(screen.queryByTestId('recent-rail')).toBeNull();
  });
});

describe('App — deep-link / shareable URLs (Feature #6)', () => {
  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  });

  it('restores an open collection + view mode from the URL hash on load', async () => {
    window.history.replaceState(null, '', '#c=101&mode=continuous-horizontal');
    renderApp({ api: createFakeApi({ viewerUserId: 99 }) });
    const viewer = await screen.findByTestId('collection-viewer');
    expect(viewer).toHaveAttribute('data-mode', 'continuous-horizontal');
  });

  it('restores the classic playback position from the hash', async () => {
    window.history.replaceState(null, '', '#c=101&i=2');
    renderApp({ api: createFakeApi({ viewerUserId: 99 }) });
    await screen.findByTestId('player');
    // Neon Cities (101) has 3 items → index 2 is item 3/3.
    expect(screen.getByTestId('progress-label')).toHaveTextContent('3 / 3');
  });

  it('writes the open collection to the URL hash, and clears it on exit', async () => {
    window.history.replaceState(null, '', window.location.pathname);
    renderApp({ api: createFakeApi({ viewerUserId: 99 }) });
    const grid = await screen.findByTestId('collection-grid');
    await userEvent.click(within(grid).getAllByTestId('collection-card')[0]); // Neon Cities (101)
    await screen.findByTestId('collection-viewer');
    await waitFor(() => expect(window.location.hash).toContain('c=101'));
    await userEvent.click(screen.getByTestId('viewer-exit'));
    await screen.findByTestId('collection-grid');
    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('the Share button copies a deep link to the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const prevClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      window.history.replaceState(null, '', window.location.pathname);
      renderApp({ api: createFakeApi({ viewerUserId: 99 }) });
      const grid = await screen.findByTestId('collection-grid');
      await userEvent.click(within(grid).getAllByTestId('collection-card')[0]);
      await screen.findByTestId('collection-viewer');
      await userEvent.click(screen.getByTestId('viewer-share'));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      expect(String(writeText.mock.calls[0][0])).toContain('#c=101');
      expect(await screen.findByTestId('toast-success')).toHaveTextContent(/copied/i);
    } finally {
      if (prevClipboard) Object.defineProperty(navigator, 'clipboard', prevClipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

describe('App — failed collection-open retry (ship-blocker #5)', () => {
  it('shows a retry affordance when opening fails, and a retry can succeed', async () => {
    const base = createFakeApi({ viewerUserId: 99 });
    let fail = true;
    const api: ApiClient = {
      ...base,
      async getCollection(id, opts) {
        if (fail) throw new ApiError('unknown', 500, 'open boom');
        return base.getCollection(id, opts);
      },
    };
    renderApp({ api });
    const grid = await screen.findByTestId('collection-grid');
    await userEvent.click(within(grid).getAllByTestId('collection-card')[0]);
    // Open failed → a retry affordance (not the player, not a bare toast).
    expect(await screen.findByTestId('open-error')).toBeInTheDocument();
    expect(screen.queryByTestId('player')).toBeNull();
    // Retry after the server recovers → the player opens.
    fail = false;
    await userEvent.click(screen.getByTestId('open-retry'));
    await screen.findByTestId('player');
  });
});

describe('App — keyboard-operable tablist (ship-blocker #4)', () => {
  it('wires a roving tablist: selected tab tabbable + aria-controls a tabpanel', async () => {
    renderApp({ api: createFakeApi({ viewerUserId: 99 }) });
    await screen.findByTestId('collection-grid');
    const discover = screen.getByTestId('tab-discover');
    const mine = screen.getByTestId('tab-mine');
    expect(discover).toHaveAttribute('role', 'tab');
    expect(discover).toHaveAttribute('aria-selected', 'true');
    expect(discover).toHaveAttribute('tabindex', '0');
    expect(mine).toHaveAttribute('tabindex', '-1');
    // aria-controls points at a real tabpanel labelled by the active tab.
    const panelId = discover.getAttribute('aria-controls');
    const panel = document.getElementById(panelId!);
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'tab-discover');
  });

  it('ArrowRight moves selection + focus to the next tab', async () => {
    renderApp({ api: createFakeApi({ viewerUserId: 99 }) });
    await screen.findByTestId('collection-grid');
    screen.getByTestId('tab-discover').focus();
    await userEvent.keyboard('{ArrowRight}');
    const mine = screen.getByTestId('tab-mine');
    expect(mine).toHaveAttribute('aria-selected', 'true');
    expect(mine).toHaveFocus();
    expect(mine).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('tab-discover')).toHaveAttribute('tabindex', '-1');
  });
});

describe('App — popular rail resolves ids absent from loaded lists (v0.1.9)', () => {
  it('shows a popular collection that is NOT on the current discover/mine page', async () => {
    const base = createFakeApi({ viewerUserId: 99 });
    const api: ApiClient = {
      ...base,
      async getCollection(id, opts) {
        if (id === 999) {
          return {
            collection: { id: 999, name: 'Hidden Gem', description: null, curator: { userId: 3, username: 'zed' }, isPublic: true, followed: false },
            items: [{ mediaId: 5, type: 'image', url: 'https://x/5.jpg', width: 1, height: 1, creator: { userId: 3, username: 'zed' }, nsfwLevel: 1 }],
          };
        }
        return base.getCollection(id, opts);
      },
    };
    renderApp({
      api,
      // Hidden Gem is the SUBJECT (an id absent from every loaded list); the two
      // companions exist only so the rail clears POPULAR_MIN_ENTRIES and renders.
      shared: {
        seed: [
          { value: { title: 'Hidden Gem', data: { collectionId: 999 } }, voters: [1, 2, 3, 4, 5] },
          { value: { title: 'Neon Cities', data: { collectionId: 101 } }, voters: [1, 2] },
          { value: { title: 'Forest Studies', data: { collectionId: 102 } }, voters: [1, 2, 3] },
        ],
      },
    });
    await screen.findByTestId('collection-grid');
    const rail = await screen.findByTestId('popular-rail');
    expect(rail).toHaveTextContent('Hidden Gem');
    // 🔴 SCOPED TO THE SUBJECT, not to "the only card". The rail now needs three
    // entries to render at all, so `getByTestId('popular-card')` is ambiguous by
    // construction; the two companions exist only to clear the entry floor and
    // are not what this test is about. Asserting on the whole set would couple
    // this test to the threshold's value.
    const gem = within(rail)
      .getAllByTestId('popular-card')
      .find((el) => el.getAttribute('aria-label')?.includes('Hidden Gem'));
    expect(gem).toBeDefined();
    expect(gem).toHaveAttribute('aria-label', 'Play Hidden Gem — played 5 times');
  });

  it('drops an unresolvable popular id (getCollection 404) — rail hidden, not crashed', async () => {
    const base = createFakeApi({ viewerUserId: 99 });
    const api: ApiClient = {
      ...base,
      async getCollection(id, opts) {
        if (id === 888) throw new ApiError('not_found', 404, 'gone');
        return base.getCollection(id, opts);
      },
    };
    renderApp({
      api,
      shared: { seed: [{ value: { title: 'Ghost', data: { collectionId: 888 } }, voters: [1, 2] }] },
    });
    await screen.findByTestId('collection-grid');
    await waitFor(() => expect(screen.queryByTestId('popular-rail')).toBeNull());
    expect(screen.getByTestId('collection-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-error')).toBeNull();
  });

  it('hides the rail (no crash) when the shared store is empty', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    renderApp({ api, shared: { seed: [] } });
    await screen.findByTestId('collection-grid');
    expect(screen.queryByTestId('popular-rail')).toBeNull();
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

// ---------------------------------------------------------------------------
// Popularity window (clawgate 542)
// ---------------------------------------------------------------------------

/**
 * Four public collections with a DIFFERENT ranking in every window.
 *
 * 🔴 The orders below are pairwise distinct on purpose. A fixture whose windows
 * produce the same list makes criterion 2 unprovable — the assertion would pass
 * for the right period and the wrong one alike, and the test would be green
 * while the app ignored the control entirely.
 *
 *   day     -> D C B A      week    -> B C D A      month -> B D A C
 *   year    -> C A D B      allTime -> A B C D  (unranked, insertion order,
 *                                       mirroring the server's Postgres path)
 */
const windowSeeds = () => {
  const curator = { userId: 11, username: 'alice' };
  const seed = (
    id: number,
    name: string,
    popularity: { day: number; week: number; month: number; year: number },
  ) => ({
    summary: {
      id,
      name,
      description: null,
      coverImageUrl: null,
      itemCount: 1,
      curator,
      isPublic: true,
      followed: false,
    },
    items: [
      {
        mediaId: id * 10,
        type: 'image' as const,
        url: `https://example.invalid/i/${id}.jpg`,
        width: 10,
        height: 10,
        creator: curator,
        nsfwLevel: 1,
      },
    ],
    popularity,
  });
  return [
    seed(301, 'Alpha', { day: 1, week: 1, month: 2, year: 3 }),
    seed(302, 'Bravo', { day: 2, week: 4, month: 4, year: 1 }),
    seed(303, 'Charlie', { day: 3, week: 3, month: 1, year: 4 }),
    seed(304, 'Delta', { day: 4, week: 2, month: 3, year: 2 }),
  ];
};

/** The card names currently rendered in the grid, in order. */
async function gridOrder(): Promise<string[]> {
  const grid = await screen.findByTestId('collection-grid');
  return within(grid)
    .getAllByTestId('collection-card')
    .map((el) => el.textContent ?? '')
    .map((t) => ['Alpha', 'Bravo', 'Charlie', 'Delta'].find((n) => t.includes(n)) ?? '?');
}

describe('the popularity window', () => {
  it('offers all five periods and defaults to This month (criterion 1)', async () => {
    renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');

    const chips = ['period-day', 'period-week', 'period-month', 'period-year', 'period-alltime'];
    for (const id of chips) expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.getByTestId('period-day')).toHaveTextContent('Today');
    expect(screen.getByTestId('period-week')).toHaveTextContent('This week');
    expect(screen.getByTestId('period-month')).toHaveTextContent('This month');
    expect(screen.getByTestId('period-year')).toHaveTextContent('This year');
    expect(screen.getByTestId('period-alltime')).toHaveTextContent('All time');

    // Exactly one is pressed, and it is Month.
    expect(screen.getByTestId('period-month')).toHaveAttribute('aria-pressed', 'true');
    for (const id of chips.filter((i) => i !== 'period-month')) {
      expect(screen.getByTestId(id)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('🔴 changing the window changes the ORDER of the returned rows (criterion 2)', async () => {
    // Not "the request carried the param" — the thing a viewer sees is the
    // order, so that is what this asserts. The five expected orders are pairwise
    // distinct (see `windowSeeds`), so each assertion can only pass for its own
    // period.
    renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');

    // Default window: Month.
    await waitFor(async () => expect(await gridOrder()).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']));

    await userEvent.click(screen.getByTestId('period-day'));
    await waitFor(async () => expect(await gridOrder()).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']));

    await userEvent.click(screen.getByTestId('period-week'));
    await waitFor(async () => expect(await gridOrder()).toEqual(['Bravo', 'Charlie', 'Delta', 'Alpha']));

    await userEvent.click(screen.getByTestId('period-year'));
    await waitFor(async () => expect(await gridOrder()).toEqual(['Charlie', 'Alpha', 'Delta', 'Bravo']));

    // AllTime takes the server's original unranked ordering.
    await userEvent.click(screen.getByTestId('period-alltime'));
    await waitFor(async () => expect(await gridOrder()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']));

    // …and back, which is the case a `period`-less cache key would break: the
    // Month rows would be served from the AllTime entry and the order would not
    // move at all.
    await userEvent.click(screen.getByTestId('period-month'));
    await waitFor(async () => expect(await gridOrder()).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']));
  });

  it('sends the selected window to the API as `period`', async () => {
    const base = createFakeApi({ collections: windowSeeds() });
    const seen: Array<{ sort?: string; period?: string; cursor?: string }> = [];
    const api: ApiClient = {
      ...base,
      async listCollections(params) {
        if (params.mode === 'public') seen.push({ sort: params.sort, period: params.period, cursor: params.cursor });
        return base.listCollections(params);
      },
    };
    renderApp({ api });
    await screen.findByTestId('collection-grid');
    await waitFor(() => expect(seen.some((s) => s.sort === 'popular' && s.period === 'month')).toBe(true));

    seen.length = 0;
    await userEvent.click(screen.getByTestId('period-week'));
    await waitFor(() => expect(seen.some((s) => s.period === 'week')).toBe(true));
    // A fresh page-1 fetch, not a continuation of the previous window's pages.
    expect(seen.every((s) => s.cursor === undefined)).toBe(true);
  });

  it('names the active period in the sort hint, keeping the capture recipe literal (criterion 4)', async () => {
    renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');
    const hint = () => screen.getByTestId('sort-hint');

    // 🔴 `toHaveTextContent` is a substring match, so the first assertion in each
    // pair is what pins the EXACT literal that talos-infra's app-capture recipe
    // waits on (`waitForGone: "Sorted by most followed."`). Reword it and that
    // wait does not go red — it goes vacuously green.
    expect(hint().textContent).toContain('Sorted by most followed.');
    expect(hint().textContent).toBe('Sorted by most followed. Popular this month.');

    await userEvent.click(screen.getByTestId('period-day'));
    expect(hint().textContent).toBe('Sorted by most followed. Popular today.');

    await userEvent.click(screen.getByTestId('period-alltime'));
    expect(hint().textContent).toBe('Sorted by most followed. Popular all time.');
    expect(hint().textContent).toContain('Sorted by most followed.');
  });

  it('applies the window to the popular sort ONLY — Newest is unaffected (criterion 6)', async () => {
    const base = createFakeApi({ collections: windowSeeds() });
    const seen: Array<{ sort?: string; period?: string }> = [];
    const api: ApiClient = {
      ...base,
      async listCollections(params) {
        if (params.mode === 'public') seen.push({ sort: params.sort, period: params.period });
        return base.listCollections(params);
      },
    };
    renderApp({ api });
    await screen.findByTestId('collection-grid');

    await userEvent.click(screen.getByTestId('sort-newest'));
    await waitFor(() => expect(seen.some((s) => s.sort === 'newest')).toBe(true));

    // No period is SENT on the newest sort. The server would accept it and
    // discard it (`period-ignored-for-non-popularity-sort`), so sending one buys
    // a param that changes nothing and a reason string to suppress.
    expect(seen.filter((s) => s.sort === 'newest').every((s) => s.period === undefined)).toBe(true);
    // The control is hidden rather than disabled: a viewer cannot pick a window
    // here, see nothing change, and have to be told why.
    expect(screen.queryByTestId('period-group')).toBeNull();
    expect(screen.getByTestId('sort-hint').textContent).toBe('Sorted newest first.');
  });

  it('remembers the chosen window while the control is hidden under Newest', async () => {
    renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');

    await userEvent.click(screen.getByTestId('period-year'));
    await waitFor(async () => expect(await gridOrder()).toEqual(['Charlie', 'Alpha', 'Delta', 'Bravo']));

    await userEvent.click(screen.getByTestId('sort-newest'));
    expect(screen.queryByTestId('period-group')).toBeNull();

    await userEvent.click(screen.getByTestId('sort-popular'));
    expect(screen.getByTestId('period-year')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('sort-hint').textContent).toBe('Sorted by most followed. Popular this year.');
  });

  it('🔴 never sends a window on the MINE feed, and never claims one there', async () => {
    // Measured live: `mode=mine&period=Month` comes back
    // `source: 'postgres', sourceReason: 'period-ignored-outside-public-discovery'`.
    // The viewer's own collections are NOT hidden — same rows, same order — but a
    // ranked window answered by Postgres is indistinguishable at the consumer
    // from ClickHouse being down. Sending it anyway would have hung a permanent,
    // false "ranking isn't available right now" note under this tab. The task's
    // non-goals say this tab has no popularity window, so the fix and the scope
    // agree: the period is a PUBLIC-DISCOVERY concept.
    // viewerUserId 11 = the seeds' curator, so `mode=mine` actually returns rows;
    // an empty Mine grid would make every assertion below vacuous.
    const base = createFakeApi({ viewerUserId: 11, collections: windowSeeds() });
    const seen: Array<{ mode: string; period?: string }> = [];
    const api: ApiClient = {
      ...base,
      async listCollections(params) {
        seen.push({ mode: params.mode, period: params.period });
        return base.listCollections(params);
      },
    };
    renderApp({ api, isPrivateGranted: () => true });
    await screen.findByTestId('collection-grid');
    await userEvent.click(screen.getByTestId('tab-mine'));
    // Positive control: the Mine grid really has rows, so the assertions below
    // are about the window and not about an empty tab.
    await waitFor(async () => expect((await gridOrder()).length).toBe(4));

    await waitFor(() => expect(seen.some((s) => s.mode === 'mine')).toBe(true));
    expect(seen.filter((s) => s.mode === 'mine').every((s) => s.period === undefined)).toBe(true);
    // …while the PUBLIC feed still got one.
    expect(seen.some((s) => s.mode === 'public' && s.period === 'month')).toBe(true);

    // No control, no window named, no end-of-list marker — this tab is untouched.
    expect(screen.queryByTestId('period-group')).toBeNull();
    expect(screen.getByTestId('sort-hint').textContent).toBe('Sorted by most followed.');
    expect(screen.queryByTestId('period-fallback')).toBeNull();
    expect(screen.queryByTestId('grid-end')).toBeNull();
  });

  it('is keyboard operable and labelled, matching the sort control (criterion 5)', async () => {
    renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');

    const group = screen.getByTestId('period-group');
    const sortGroup = screen.getByTestId('sort-popular').closest('[role="group"]')!;
    // Same ARIA pattern as the existing sort chips: a labelled group of
    // `aria-pressed` toggle buttons. NOT roving tabindex — that belongs to the
    // Discover/Mine `role="tab"` strip, where the ARIA pattern requires it; a
    // group of toggle buttons must not take Tab away from its own members.
    expect(group).toHaveAttribute('role', 'group');
    expect(sortGroup).toHaveAttribute('role', 'group');
    expect(group).toHaveAccessibleName('Popularity window');
    expect(sortGroup).toHaveAccessibleName('Sort collections');

    for (const id of ['period-day', 'period-week', 'period-month', 'period-year', 'period-alltime']) {
      const el = screen.getByTestId(id);
      expect(el.tagName).toBe('BUTTON');
      // Every chip reachable by Tab, exactly like the sort chips.
      expect(el).not.toHaveAttribute('tabindex', '-1');
      expect(el).toHaveAttribute('aria-pressed');
    }

    // Activating by KEYBOARD (not a click) really changes the window.
    screen.getByTestId('period-day').focus();
    expect(screen.getByTestId('period-day')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('period-day')).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(async () => expect(await gridOrder()).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']));
  });

  it('persists the window exactly as the sort persists it — i.e. not at all (criterion 3)', async () => {
    // 🔴 A RELATIONSHIP guard, not a behaviour preference. Criterion 3 asks the
    // period to persist "in the same way the existing sort choice does"; measured,
    // the sort does not persist at all (no localStorage key, no URL presence).
    // This pins the two AGREEING, so it stays honest if someone later gives both
    // a mechanism — and goes red if the period grows one the sort lacks.
    const store = globalThis.localStorage;
    const before = { ...store };
    const { unmount } = renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');
    await userEvent.click(screen.getByTestId('period-year'));
    await userEvent.click(screen.getByTestId('sort-newest'));
    await userEvent.click(screen.getByTestId('sort-popular'));
    expect(screen.getByTestId('period-year')).toHaveAttribute('aria-pressed', 'true');

    // Neither choice wrote anything.
    expect({ ...store }).toEqual(before);

    unmount();
    renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');
    // A remount is a reload: sort is back to Popular and period back to Month.
    expect(screen.getByTestId('sort-popular')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('period-month')).toHaveAttribute('aria-pressed', 'true');
  });

  it('🔴 says so when the server could not serve the asked-for window', async () => {
    // ClickHouse unavailable: the server answers from Postgres in the ALL-TIME
    // order. Presenting that as "this month" would be a lie the viewer cannot
    // detect, so an unobtrusive note names what was actually served.
    renderApp({ api: createFakeApi({ collections: windowSeeds(), listWindowUnavailable: true }) });
    await screen.findByTestId('collection-grid');
    const note = await screen.findByTestId('period-fallback');
    expect(note).toHaveTextContent(
      "Ranking for this month isn't available right now — showing all-time popularity instead.",
    );
    // The hint still describes the CONTROL's state; the note describes the serve.
    expect(screen.getByTestId('sort-hint').textContent).toBe('Sorted by most followed. Popular this month.');
  });

  it('🔴 stays silent on a healthy AllTime request, whose sourceReason is expected', async () => {
    // Live: `period=AllTime` returns `sourceReason: 'all-time-served-from-postgres'`.
    // A note keyed on that field's presence would fire on an ordinary request.
    renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');
    expect(screen.queryByTestId('period-fallback')).toBeNull();
    await userEvent.click(screen.getByTestId('period-alltime'));
    await waitFor(async () => expect(await gridOrder()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']));
    expect(screen.queryByTestId('period-fallback')).toBeNull();
  });

  it('🔴 ends the grid gracefully instead of just stopping', async () => {
    // The default window is ClickHouse-ranked and BOUNDED — ~446 Image
    // collections, ~18 pages at limit 24 — where all-time pages the whole
    // corpus. Before this the grid rendered nothing at the end of the list,
    // which at the bottom of a scroll reads as a broken loader.
    renderApp({ api: createFakeApi({ collections: windowSeeds() }) });
    await screen.findByTestId('collection-grid');
    expect(await screen.findByTestId('grid-end')).toHaveTextContent(
      "That's the end of this month's popular collections — pick a longer window for more.",
    );

    // On all-time there is no longer window to offer, so the line stays generic.
    await userEvent.click(screen.getByTestId('period-alltime'));
    await waitFor(() => expect(screen.getByTestId('grid-end')).toHaveTextContent("That's the end of the results."));
  });
});
