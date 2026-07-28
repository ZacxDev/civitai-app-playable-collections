// Playable Collections — top-level W10 page app.
//
// Two browse tabs (Discover public / My collections) + a cross-user Popular
// rail → open a collection into the full-page Player. All network goes through
// the injectable `ApiClient` (props.api in tests/dev; a real block-token HTTP
// client in production). Buzz balance, follow state, and tips are owned here so
// the Player stays presentation + local interaction.
//
// v0.1.5 feedback:
//   #1 the discover/mine lists PAGINATE — an infinite-scroll sentinel appends the
//      next page via the response `nextCursor` (dedupe by id — the public-mode
//      cursor is inclusive and can re-emit the last row). Off-screen cover
//      thumbnails load lazily (CollectionGrid).
//   #2 opening a collection loads ONLY page 1 (one fetch) then streams the rest
//      on demand as the player nears the tail (see openCollection / loadMoreOpen).
//   #3 the sort control is an explicit Popular ↔ Newest toggle, Popular labelled
//      "Most followed".
//   #4 every surface is built from `@civitai/blocks-react/ui`; the pack styles
//      itself, and the app themes itself by setting `data-theme` on its own root
//      (the host can't reach inside the iframe — gotcha #60).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzBalance,
  useHostOrigin,
  useRequestConsent,
  useRequestSignIn,
  useSharedStorage,
} from '@civitai/blocks-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  TextInput,
  injectBlocksStyles,
} from '@civitai/blocks-react/ui';

import { ApiError, createHttpApiClient, type ApiClient } from './lib/api.js';
import { createCachedApiClient } from './lib/cache.js';
import { readPopular, recordPlay, totalBuzz } from './lib/popular.js';
import { MAX_DETAIL_PAGES, loadCollectionFirstPage, loadMoreItems } from './lib/collection-loader.js';
import { DEFAULT_RETRY, withBoundedRetry, type RetryConfig } from './lib/retry.js';
import { usePlayerSettings } from './settings.js';
import { COLLECTIONS_READ_PRIVATE, defaultHasPrivateScope } from './scopes.js';
import { palette } from './theme.js';
import { useIsMobile } from './useMediaQuery.js';
import type {
  CollectionDetail,
  CollectionSort,
  CollectionSummary,
  MediaItem,
} from './types.js';
import { CollectionGrid, PopularRail } from './components/CollectionGrid.js';
import { CollectionViewer } from './components/CollectionViewer.js';
import type { TipTarget } from './components/TipModal.js';
import { ToastHost, useToasts } from './components/toast.js';

const POPULAR_LIMIT = 10;
const PAGE_LIMIT = 24;

type Tab = 'discover' | 'mine';

interface ListState {
  items: CollectionSummary[];
  loading: boolean;
  error: string | null;
  /** Cursor for the next page; undefined when the list is fully loaded. */
  nextCursor?: string;
  /** A next-page (infinite-scroll) fetch is in flight. */
  loadingMore: boolean;
}

const EMPTY_LIST: ListState = { items: [], loading: false, error: null, nextCursor: undefined, loadingMore: false };

interface OpenCollection {
  detail: CollectionDetail;
  items: MediaItem[];
  followed: boolean;
  /** Cursor for the next detail page; undefined when fully loaded. */
  nextCursor?: string;
  /** Pages fetched so far (safety ceiling = MAX_DETAIL_PAGES). */
  pages: number;
}

/** Append `incoming` onto `existing`, dropping ids already present (inclusive-cursor re-emit). */
function mergeSummaries(existing: CollectionSummary[], incoming: CollectionSummary[]): CollectionSummary[] {
  const seen = new Set(existing.map((s) => s.id));
  const add = incoming.filter((s) => !seen.has(s.id));
  return add.length ? [...existing, ...add] : existing;
}

export interface AppProps {
  /** Inject a fake ApiClient in tests/dev; production builds the real HTTP client. */
  api?: ApiClient;
  /**
   * Predicate over the current block-token scopes deciding whether the viewer
   * has granted the consent-gated `collections:read:private` scope. Defaults to
   * the real check. A test seam (like `api`): the SDK mock host models consent
   * for `ai:write:budgeted`, so a test maps that to the private grant to drive
   * the real request→re-mint→observe round-trip.
   */
  isPrivateGranted?: (tokenScopes: string[]) => boolean;
  /** Bounded-retry config for the auto-run data loaders (test seam). */
  retry?: RetryConfig;
}

export function App({ api: injectedApi, isPrivateGranted, retry = DEFAULT_RETRY }: AppProps = {}) {
  const { ready, viewer, theme } = useBlockContext();
  const token = useBlockToken();
  const host = useHostOrigin();
  const { requestSignIn } = useRequestSignIn();
  const { requestConsent } = useRequestConsent();
  const isMobile = useIsMobile();
  const toasts = useToasts();

  // Buzz balance via the host-mediated GET_BUZZ_BALANCE bridge (scope-free) —
  // NOT a block HTTP endpoint (the old `/api/v1/blocks/buzz` was retired by
  // civitai #3144). Returns per-pool { blue, green, yellow }; we sum to one
  // spendable figure for the header pill + the tip modal's soft ceiling.
  const { balance: buzzPools, refetch: refetchBalance } = useBuzzBalance();
  const balance = totalBuzz(buzzPools);

  // Cross-user "popular" play-counts via App Blocks SHARED storage
  // (apps:storage:shared:* postMessage bridge) — replaces the guessed
  // `/api/v1/blocks/shared-storage/{increment,top}` REST routes. Stable identity
  // across renders, so it's safe in the effect/callback deps below.
  const shared = useSharedStorage();

  // Inject the component-pack stylesheet into the block document once (gotcha
  // #60). Themed via `data-theme` on the app's own root below.
  useEffect(() => {
    injectBlocksStyles();
  }, []);

  // Device-local playback prefs (localStorage) — the host does not deliver
  // viewer settings on a page app (see settings.ts).
  const { settings: playerSettings, setSecondsPerImage, setVideoLoopCount } = usePlayerSettings();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  const c = palette(theme === 'dark');
  const dataTheme = theme === 'dark' ? 'dark' : 'light';

  // Has the viewer granted the consent-gated private-collections scope? The
  // block-token mint withholds it until consent, so it appears on the token's
  // scopes only after a grant + re-mint (TOKEN_REFRESH).
  const hasPrivateScope = (isPrivateGranted ?? defaultHasPrivateScope)(token.scopes ?? []);

  const requestPrivateConsent = useCallback(() => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    // Fire-and-forget: the host opens its consent UI; on grant it re-mints the
    // token with the scope and pushes TOKEN_REFRESH, which flips hasPrivateScope
    // and triggers a mine reload below. Declined => nothing changes (no error).
    requestConsent({ scopes: [COLLECTIONS_READ_PRIVATE] });
  }, [viewer, requestSignIn, requestConsent]);

  // Real HTTP client (prod) unless a fake is injected (tests/dev).
  //
  // 🔴 The API lives on the CIVITAI HOST, not this block's own subdomain — a
  // same-origin fetch hits playable-collections.civit.ai and gets the SPA
  // index.html (parse error -> the old infinite loop). `useHostOrigin()` is the
  // SDK's allowlist-VALIDATED parent origin (never document.referrer). It's
  // `undefined` until BLOCK_INIT, so we build NO client and fetch NOTHING until
  // BOTH the host origin AND the bearer token are present.
  //
  // 🔴 `useBlockToken()` returns a FRESH object every render (`{...token,
  // refresh}`), so memoizing on the token OBJECT would rebuild the client (and
  // re-run every loader) each render — an infinite fetch loop. Memoize on the
  // STABLE `token.raw` string, and read the live token/refresh via a ref.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const tokenRaw = token.raw;
  // Wrapped in a session cache (feedback #3): the collections-list + collection-
  // detail responses are memoized in-memory so switching tabs / re-opening a
  // collection is instant and doesn't re-hit the private,no-store origin. The
  // cache is bound to this memo (per host+token), and follow mutations clear it.
  // Media/CDN image URLs still browser-cache normally (untouched).
  const realApi = useMemo<ApiClient | null>(
    () =>
      host && tokenRaw
        ? createCachedApiClient(
            createHttpApiClient({
              baseUrl: host,
              getToken: () => tokenRef.current.raw,
              refreshToken: () => tokenRef.current.refresh(),
            }),
          )
        : null,
    [host, tokenRaw],
  );
  const api = injectedApi ?? realApi;
  // Data-fetching is gated on a usable client (injected fake, or the real client
  // once host+token are established).
  const canFetch = api != null;

  // ---- browse state ----
  const [tab, setTab] = useState<Tab>('discover');
  const [search, setSearch] = useState('');
  // Default the discovery sort to popular (feedback #3). On the wire this becomes
  // the deployed server's `Most Followers` (CollectionSort.MostContributors) via
  // SORT_PARAM in lib/api.ts — no dependency on any undeployed server enum.
  const [sort, setSort] = useState<CollectionSort>('popular');
  const [discover, setDiscover] = useState<ListState>({ ...EMPTY_LIST, loading: true });
  const [mine, setMine] = useState<ListState>(EMPTY_LIST);
  const [popular, setPopular] = useState<Array<{ collection: CollectionSummary; count: number }>>([]);

  // Live refs so the infinite-scroll `onLoadMore` (called from an observer
  // callback) always reads the latest cursor / in-flight flag, never a stale
  // closure.
  const discoverRef = useRef(discover);
  discoverRef.current = discover;
  const mineRef = useRef(mine);
  mineRef.current = mine;

  // ---- player state ----
  const [open, setOpen] = useState<OpenCollection | null>(null);
  const openRef = useRef<OpenCollection | null>(null);
  openRef.current = open;
  const [openLoading, setOpenLoading] = useState(false);
  const [openMorePending, setOpenMorePending] = useState(false);
  const openMorePendingRef = useRef(false);
  openMorePendingRef.current = openMorePending;
  const [followPending, setFollowPending] = useState(false);
  const [tipping, setTipping] = useState(false);

  // Known-collection lookup (for resolving popular ids to cards).
  const known = useMemo(() => {
    const map = new Map<number, CollectionSummary>();
    for (const s of discover.items) map.set(s.id, s);
    for (const s of mine.items) map.set(s.id, s);
    return map;
  }, [discover.items, mine.items]);

  // ---- loaders ----
  // The auto-run list loaders are wrapped in `withBoundedRetry` — a persistent
  // failure (parse/HTML, 4xx, or an exhausted 5xx/network) lands in the error
  // state with a manual retry, NEVER an unbounded loop.
  const loadDiscover = useCallback(async () => {
    if (!api) return;
    setDiscover((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await withBoundedRetry(
        () => api.listCollections({ mode: 'public', query: search, sort, limit: PAGE_LIMIT }),
        retry,
      );
      setDiscover({ items: page.items, loading: false, error: null, nextCursor: page.nextCursor, loadingMore: false });
    } catch (err) {
      setDiscover({ ...EMPTY_LIST, error: errMessage(err) });
    }
  }, [api, search, sort, retry]);

  const loadMine = useCallback(async () => {
    if (!api) return;
    if (!viewer) {
      setMine(EMPTY_LIST);
      return;
    }
    setMine((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await withBoundedRetry(
        () => api.listCollections({ mode: 'mine', query: search, sort, limit: PAGE_LIMIT }),
        retry,
      );
      setMine({ items: page.items, loading: false, error: null, nextCursor: page.nextCursor, loadingMore: false });
    } catch (err) {
      setMine({ ...EMPTY_LIST, error: errMessage(err) });
    }
  }, [api, viewer, search, sort, retry]);

  // Infinite-scroll page loaders (feedback #1): fetch the next page via the
  // stored `nextCursor` and append, deduping the inclusive-cursor re-emit.
  const loadMoreDiscover = useCallback(async () => {
    if (!api) return;
    const s = discoverRef.current;
    if (!s.nextCursor || s.loadingMore) return;
    const cursor = s.nextCursor;
    setDiscover((p) => ({ ...p, loadingMore: true }));
    try {
      const page = await api.listCollections({ mode: 'public', query: search, sort, cursor, limit: PAGE_LIMIT });
      setDiscover((p) => ({
        ...p,
        items: mergeSummaries(p.items, page.items),
        nextCursor: page.nextCursor,
        loadingMore: false,
      }));
    } catch {
      setDiscover((p) => ({ ...p, loadingMore: false }));
    }
  }, [api, search, sort]);

  const loadMoreMine = useCallback(async () => {
    if (!api || !viewer) return;
    const s = mineRef.current;
    if (!s.nextCursor || s.loadingMore) return;
    const cursor = s.nextCursor;
    setMine((p) => ({ ...p, loadingMore: true }));
    try {
      const page = await api.listCollections({ mode: 'mine', query: search, sort, cursor, limit: PAGE_LIMIT });
      setMine((p) => ({
        ...p,
        items: mergeSummaries(p.items, page.items),
        nextCursor: page.nextCursor,
        loadingMore: false,
      }));
    } catch {
      setMine((p) => ({ ...p, loadingMore: false }));
    }
  }, [api, viewer, search, sort]);

  const loadPopular = useCallback(async () => {
    try {
      const entries = await readPopular(shared, POPULAR_LIMIT);
      const resolved = entries
        .map((e) => {
          const collection = known.get(e.collectionId);
          return collection ? { collection, count: e.count } : null;
        })
        .filter((x): x is { collection: CollectionSummary; count: number } => x !== null);
      setPopular(resolved);
    } catch {
      // Popular is a nice-to-have; never block the page on it.
      setPopular([]);
    }
  }, [shared, known]);

  // ---- effects ---- (all gated on `canFetch`: don't fetch until the host
  // origin + token are established, or the loop's root cause returns)
  useEffect(() => {
    if (!ready || !canFetch) return;
    void loadDiscover();
  }, [ready, canFetch, loadDiscover]);

  useEffect(() => {
    if (!ready || !canFetch) return;
    // Reload when the private scope is granted (re-mint) so the viewer's private
    // collections appear without a manual refresh.
    if (tab === 'mine') void loadMine();
  }, [ready, canFetch, tab, loadMine, hasPrivateScope]);

  // Recompute the popular rail whenever the known-collections map changes.
  useEffect(() => {
    if (!ready || !canFetch) return;
    void loadPopular();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, canFetch, known]);

  // ---- open a collection into the player (+ increment shared play-count) ----
  // Loads ONLY the first page (one fetch); the player streams the rest on demand.
  const openCollection = useCallback(
    async (summary: CollectionSummary) => {
      if (!api) return;
      setOpenLoading(true);
      setOpen(null);
      try {
        const page = await loadCollectionFirstPage(api, summary.id);
        setOpen({
          detail: page.collection,
          items: page.items,
          followed: page.collection.followed,
          nextCursor: page.nextCursor,
          pages: 1,
        });
        // Fire-and-forget the shared play-count vote; a failure never blocks
        // playback (anon viewers reject on the write path — that's fine).
        recordPlay(shared, summary)
          .then(() => loadPopular())
          .catch(() => {});
      } catch (err) {
        toasts.push('error', errMessage(err));
      } finally {
        setOpenLoading(false);
      }
    },
    [api, shared, loadPopular, toasts],
  );

  // Progressive detail load: fetch the next page on demand (player nears the
  // tail). Bounded by MAX_DETAIL_PAGES so a pathological collection can't loop.
  const loadMoreOpen = useCallback(async () => {
    if (!api) return;
    const o = openRef.current;
    if (!o || !o.nextCursor || o.pages >= MAX_DETAIL_PAGES) return;
    if (openMorePendingRef.current) return;
    const cursor = o.nextCursor;
    const id = o.detail.id;
    setOpenMorePending(true);
    try {
      const more = await loadMoreItems(api, id, cursor);
      setOpen((prev) => {
        if (!prev || prev.detail.id !== id) return prev;
        const seen = new Set(prev.items.map((i) => i.mediaId));
        const add = more.items.filter((i) => !seen.has(i.mediaId));
        return {
          ...prev,
          items: add.length ? [...prev.items, ...add] : prev.items,
          nextCursor: more.nextCursor,
          pages: prev.pages + 1,
        };
      });
    } catch {
      // Keep what's already loaded; the player still plays it.
    } finally {
      setOpenMorePending(false);
    }
  }, [api]);

  const exitPlayer = useCallback(() => setOpen(null), []);

  // ---- follow toggle (optimistic + rollback) ----
  const toggleFollow = useCallback(async () => {
    if (!open || !api) return;
    if (!viewer) {
      requestSignIn();
      return;
    }
    const nextFollowed = !open.followed;
    setOpen((o) => (o ? { ...o, followed: nextFollowed } : o));
    setFollowPending(true);
    try {
      const res = await api.setFollow(open.detail.id, nextFollowed);
      setOpen((o) => (o ? { ...o, followed: res.followed } : o));
      // Keep the grid card badge in sync.
      applyFollowedToLists(open.detail.id, res.followed);
      toasts.push('success', res.followed ? 'Added to your collections.' : 'Removed the bookmark.');
    } catch (err) {
      // rollback
      setOpen((o) => (o ? { ...o, followed: !nextFollowed } : o));
      toasts.push('error', errMessage(err));
    } finally {
      setFollowPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viewer, api, requestSignIn, toasts]);

  const applyFollowedToLists = useCallback((id: number, followed: boolean) => {
    const patch = (s: ListState): ListState => ({
      ...s,
      items: s.items.map((it) => (it.id === id ? { ...it, followed } : it)),
    });
    setDiscover(patch);
    setMine(patch);
  }, []);

  // ---- tip flow ----
  const doTip = useCallback(
    async (target: TipTarget, amount: number): Promise<boolean> => {
      if (!api) return false;
      if (!viewer) {
        requestSignIn();
        return false;
      }
      setTipping(true);
      try {
        await api.tip({
          toUserId: target.toUserId,
          amount,
          entityType: target.entityType,
          entityId: target.entityId,
        });
        toasts.push('success', `Sent ${amount.toLocaleString()} Buzz to ${target.username ? '@' + target.username : 'the ' + target.kind}.`);
        refetchBalance();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'insufficient_balance') {
          toasts.push('error', "You don't have enough Buzz for that tip.");
        } else if (err instanceof ApiError && err.code === 'rate_limited') {
          toasts.push('error', 'Slow down a moment before tipping again.');
        } else {
          toasts.push('error', errMessage(err));
        }
        return false;
      } finally {
        setTipping(false);
      }
    },
    [viewer, api, requestSignIn, toasts, refetchBalance],
  );

  // ---- render ----
  // Boot gate: wait for BLOCK_INIT (ready) AND a usable client (host origin +
  // token established, or an injected fake). Until then, show loading — never
  // fetch, so the same-origin/no-host loop can't start.
  if (!ready || !canFetch) {
    return (
      <div ref={rootRef} data-theme={dataTheme} style={pageStyle()}>
        <div style={{ margin: 'auto', display: 'flex', gap: 10, alignItems: 'center', color: 'var(--civitai-color-text-dimmed)' }}>
          <Loader size="sm" />
          Loading Playable Collections…
        </div>
      </div>
    );
  }

  if (open) {
    return (
      <div ref={rootRef} data-theme={dataTheme}>
        <CollectionViewer
          key={open.detail.id}
          detail={open.detail}
          items={open.items}
          settings={playerSettings}
          onSecondsPerImageChange={setSecondsPerImage}
          onVideoLoopCountChange={setVideoLoopCount}
          viewerUserId={viewer?.id ?? null}
          buzzBalance={balance}
          followed={open.followed}
          followPending={followPending}
          onToggleFollow={toggleFollow}
          onTip={doTip}
          tipping={tipping}
          isMobile={isMobile}
          c={c}
          onExit={exitPlayer}
          hasMore={open.nextCursor != null && open.pages < MAX_DETAIL_PAGES}
          loadingMore={openMorePending}
          onLoadMore={loadMoreOpen}
        />
        <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
      </div>
    );
  }

  const activeList = tab === 'discover' ? discover : mine;

  return (
    <div ref={rootRef} data-theme={dataTheme} data-layout={isMobile ? 'mobile' : 'desktop'} style={pageStyle()}>
      <div style={contentStyle}>
        <Stack gap={16}>
          <header style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <h1 style={{ fontSize: 22, margin: 0 }}>Playable Collections</h1>
              {viewer && (
                <Badge size="lg" variant="light" data-testid="buzz-balance">
                  ⚡ {balance != null ? balance.toLocaleString() : '—'}
                </Badge>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--civitai-color-text-dimmed)' }}>
              Sit back and play through a collection's images and videos.
            </p>
          </header>

          {/* tabs */}
          <Group gap={8} role="tablist" aria-label="Collection source">
            <Button
              role="tab"
              aria-selected={tab === 'discover'}
              variant={tab === 'discover' ? 'filled' : 'light'}
              onClick={() => setTab('discover')}
              data-testid="tab-discover"
            >
              Discover
            </Button>
            <Button
              role="tab"
              aria-selected={tab === 'mine'}
              variant={tab === 'mine' ? 'filled' : 'light'}
              onClick={() => setTab('mine')}
              data-testid="tab-mine"
            >
              My collections
            </Button>
          </Group>

          {/* search + sort */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (tab === 'discover') void loadDiscover();
              else void loadMine();
            }}
          >
            <Stack gap={10}>
              <Group gap={8} align="center">
                <TextInput
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search collections…"
                  aria-label="Search collections"
                  data-testid="search-input"
                  style={{ flex: 1, minWidth: 160 }}
                />
                <Button type="submit" variant="outline" data-testid="search-submit">
                  Search
                </Button>
              </Group>

              {/* sort toggle — Popular ("Most followed") ↔ Newest (feedback #3) */}
              <Group gap={8} align="center">
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--civitai-color-text-dimmed)' }}>Sort</span>
                <Group gap={4} role="group" aria-label="Sort collections">
                  <Button
                    size="sm"
                    variant={sort === 'popular' ? 'filled' : 'light'}
                    aria-pressed={sort === 'popular'}
                    onClick={() => setSort('popular')}
                    data-testid="sort-popular"
                    title="Most followed"
                  >
                    Popular
                  </Button>
                  <Button
                    size="sm"
                    variant={sort === 'newest' ? 'filled' : 'light'}
                    aria-pressed={sort === 'newest'}
                    onClick={() => setSort('newest')}
                    data-testid="sort-newest"
                  >
                    Newest
                  </Button>
                </Group>
                <span style={{ fontSize: 12, color: 'var(--civitai-color-text-dimmed)' }} data-testid="sort-hint">
                  {sort === 'popular' ? 'Most followed' : 'Newest first'}
                </span>
              </Group>
            </Stack>
          </form>

          {/* popular rail (discover only) */}
          {tab === 'discover' && <PopularRail entries={popular} onOpen={openCollection} c={c} />}

          {/* the grid */}
          {tab === 'mine' && !viewer ? (
            <Card padding="lg" style={{ display: 'grid', gap: 10, justifyItems: 'start' }}>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--civitai-color-text-dimmed)' }} data-testid="mine-anon">
                Sign in to see the collections you've created and bookmarked.
              </p>
              <Button onClick={() => requestSignIn()} data-testid="mine-signin">
                Sign in
              </Button>
            </Card>
          ) : (
            <>
              {/* Private-collections consent affordance (mine tab, signed in, not
                  yet granted). Public own collections are always shown above; the
                  viewer opts in to reveal private ones. Never a hard error. */}
              {tab === 'mine' && viewer && !hasPrivateScope && (
                <Alert color="info" title="Your private collections are hidden" data-testid="private-consent">
                  <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                    <span>Grant access to include the collections you keep private.</span>
                    <Button size="sm" onClick={requestPrivateConsent} data-testid="enable-private">
                      Show my private collections
                    </Button>
                  </div>
                </Alert>
              )}
              <CollectionGrid
                collections={activeList.items}
                loading={activeList.loading || (tab === 'discover' && openLoading)}
                error={activeList.error}
                emptyLabel={
                  tab === 'discover'
                    ? 'No public collections match your search yet.'
                    : "You haven't created or bookmarked any collections yet."
                }
                onOpen={openCollection}
                onRetry={tab === 'discover' ? loadDiscover : loadMine}
                c={c}
                isMobile={isMobile}
                hasMore={activeList.nextCursor != null}
                loadingMore={activeList.loadingMore}
                onLoadMore={tab === 'discover' ? loadMoreDiscover : loadMoreMine}
              />
            </>
          )}
        </Stack>
      </div>
      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// ---- styles ----
function pageStyle(): CSSProperties {
  return {
    fontFamily: 'var(--civitai-font)',
    background: 'var(--civitai-color-surface-2)',
    color: 'var(--civitai-color-text)',
    width: '100%',
    minHeight: '100dvh',
    display: 'flex',
    boxSizing: 'border-box',
  };
}
const contentStyle: CSSProperties = {
  margin: '0 auto',
  width: '100%',
  maxWidth: 960,
  padding: 20,
  boxSizing: 'border-box',
};
