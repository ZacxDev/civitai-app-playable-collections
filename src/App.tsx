// Playable Collections — top-level W10 page app.
//
// Two browse tabs (Discover public / My collections) + a cross-user Popular
// rail → open a collection into the full-page Player. All network goes through
// the injectable `ApiClient` (props.api in tests/dev; a real block-token HTTP
// client in production). Buzz balance, follow state, and tips are owned here so
// the Player stays presentation + local interaction.

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

import { ApiError, createHttpApiClient, type ApiClient } from './lib/api.js';
import { readPopular, recordPlay, totalBuzz } from './lib/popular.js';
import { DEFAULT_RETRY, withBoundedRetry, type RetryConfig } from './lib/retry.js';
import { usePlayerSettings } from './settings.js';
import { COLLECTIONS_READ_PRIVATE, defaultHasPrivateScope } from './scopes.js';
import { palette, type Palette } from './theme.js';
import { useIsMobile } from './useMediaQuery.js';
import type {
  CollectionDetail,
  CollectionSort,
  CollectionSummary,
  MediaItem,
} from './types.js';
import { CollectionGrid, PopularRail } from './components/CollectionGrid.js';
import { Player } from './components/Player.js';
import type { TipTarget } from './components/TipModal.js';
import { ToastHost, useToasts } from './components/toast.js';
import { inputStyle, chipStyle, ghostBtn } from './components/styles.js';

const POPULAR_LIMIT = 10;
const PAGE_LIMIT = 24;

type Tab = 'discover' | 'mine';

interface ListState {
  items: CollectionSummary[];
  loading: boolean;
  error: string | null;
}

interface OpenCollection {
  detail: CollectionDetail;
  items: MediaItem[];
  followed: boolean;
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
  // spendable figure for the pill + tip modal.
  const { balance: buzzPools, refetch: refetchBalance } = useBuzzBalance();
  const balance = totalBuzz(buzzPools);

  // Cross-user "popular" play-counts via App Blocks SHARED storage
  // (apps:storage:shared:* postMessage bridge) — replaces the guessed
  // `/api/v1/blocks/shared-storage/{increment,top}` REST routes. Stable
  // identity across renders, so it's safe in the effect/callback deps below.
  const shared = useSharedStorage();

  // Device-local playback prefs (localStorage) — the host does not deliver
  // viewer settings on a page app (see settings.ts).
  const { settings: playerSettings, setSecondsPerImage, setVideoLoopCount } = usePlayerSettings();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  const c = palette(theme === 'dark');

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
  const realApi = useMemo<ApiClient | null>(
    () =>
      host && tokenRaw
        ? createHttpApiClient({
            baseUrl: host,
            getToken: () => tokenRef.current.raw,
            refreshToken: () => tokenRef.current.refresh(),
          })
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
  const [sort, setSort] = useState<CollectionSort>('newest');
  const [discover, setDiscover] = useState<ListState>({ items: [], loading: true, error: null });
  const [mine, setMine] = useState<ListState>({ items: [], loading: false, error: null });
  const [popular, setPopular] = useState<Array<{ collection: CollectionSummary; count: number }>>([]);

  // ---- player state ----
  const [open, setOpen] = useState<OpenCollection | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
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
      setDiscover({ items: page.items, loading: false, error: null });
    } catch (err) {
      setDiscover({ items: [], loading: false, error: errMessage(err) });
    }
  }, [api, search, sort, retry]);

  const loadMine = useCallback(async () => {
    if (!api) return;
    if (!viewer) {
      setMine({ items: [], loading: false, error: null });
      return;
    }
    setMine((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await withBoundedRetry(
        () => api.listCollections({ mode: 'mine', query: search, sort, limit: PAGE_LIMIT }),
        retry,
      );
      setMine({ items: page.items, loading: false, error: null });
    } catch (err) {
      setMine({ items: [], loading: false, error: errMessage(err) });
    }
  }, [api, viewer, search, sort, retry]);

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
  const openCollection = useCallback(
    async (summary: CollectionSummary) => {
      if (!api) return;
      setOpenLoading(true);
      setOpen(null);
      try {
        const page = await api.getCollection(summary.id, { limit: 200 });
        setOpen({ detail: page.collection, items: page.items, followed: page.collection.followed });
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
      <div ref={rootRef} data-theme={theme} style={pageStyle(c)}>
        <div style={{ margin: 'auto', opacity: 0.7 }}>Loading Playable Collections…</div>
      </div>
    );
  }

  if (open) {
    return (
      <div ref={rootRef} data-theme={theme}>
        <Player
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
        />
        <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} c={c} />
      </div>
    );
  }

  const activeList = tab === 'discover' ? discover : mine;

  return (
    <div ref={rootRef} data-theme={theme} data-layout={isMobile ? 'mobile' : 'desktop'} style={pageStyle(c)}>
      <div style={contentStyle}>
        <header style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h1 style={{ fontSize: 22, margin: 0 }}>Playable Collections</h1>
            {viewer && (
              <span style={buzzPill(c)} data-testid="buzz-balance">
                ⚡ {balance != null ? balance.toLocaleString() : '—'}
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 13, color: c.muted }}>
            Sit back and play through a collection's images and videos.
          </p>
        </header>

        {/* tabs */}
        <div style={{ display: 'flex', gap: 8 }} role="tablist" aria-label="Collection source">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'discover'}
            onClick={() => setTab('discover')}
            style={chipStyle(c, tab === 'discover')}
            data-testid="tab-discover"
          >
            Discover
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mine'}
            onClick={() => setTab('mine')}
            style={chipStyle(c, tab === 'mine')}
            data-testid="tab-mine"
          >
            My collections
          </button>
        </div>

        {/* search + sort */}
        <form
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (tab === 'discover') void loadDiscover();
            else void loadMine();
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search collections…"
            aria-label="Search collections"
            style={{ ...inputStyle(c), flex: 1, minWidth: 160 }}
            data-testid="search-input"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as CollectionSort)}
            aria-label="Sort collections"
            style={{ ...inputStyle(c), width: 'auto' }}
            data-testid="sort-select"
          >
            <option value="newest">Newest</option>
            <option value="popular">Popular</option>
          </select>
          <button type="submit" style={ghostBtn(c)} data-testid="search-submit">
            Search
          </button>
        </form>

        {/* popular rail (discover only) */}
        {tab === 'discover' && <PopularRail entries={popular} onOpen={openCollection} c={c} />}

        {/* the grid */}
        {tab === 'mine' && !viewer ? (
          <div style={{ display: 'grid', gap: 10, justifyItems: 'start' }}>
            <p style={{ margin: 0, fontSize: 14, color: c.muted }} data-testid="mine-anon">
              Sign in to see the collections you've created and bookmarked.
            </p>
            <button type="button" onClick={() => requestSignIn()} style={chipStyle(c, true)} data-testid="mine-signin">
              Sign in
            </button>
          </div>
        ) : (
          <>
            {/* Private-collections consent affordance (mine tab, signed in, not
                yet granted). Public own collections are always shown above; the
                viewer opts in to reveal private ones. Never a hard error. */}
            {tab === 'mine' && viewer && !hasPrivateScope && (
              <div style={consentBox(c)} data-testid="private-consent">
                <div style={{ display: 'grid', gap: 2 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Your private collections are hidden</span>
                  <span style={{ fontSize: 13, color: c.muted }}>
                    Grant access to include the collections you keep private.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={requestPrivateConsent}
                  style={chipStyle(c, true)}
                  data-testid="enable-private"
                >
                  Show my private collections
                </button>
              </div>
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
            />
          </>
        )}
      </div>
      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} c={c} />
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// ---- styles ----
function pageStyle(c: Palette): CSSProperties {
  return {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    background: c.bg,
    color: c.fg,
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
  display: 'grid',
  gap: 16,
  alignContent: 'start',
  boxSizing: 'border-box',
};
function buzzPill(c: Palette): CSSProperties {
  return {
    fontSize: 13,
    fontWeight: 700,
    background: c.chipBg,
    color: c.fg,
    padding: '6px 12px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
  };
}
function consentBox(c: Palette): CSSProperties {
  return {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    background: c.card,
    border: '1px dashed ' + c.border,
    borderRadius: 10,
    padding: 12,
  };
}
