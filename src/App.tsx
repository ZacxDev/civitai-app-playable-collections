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
  useBlockSettings,
  useBlockToken,
  useRequestSignIn,
} from '@civitai/blocks-react';

import { ApiError, createHttpApiClient, type ApiClient } from './lib/api.js';
import { resolveSettings } from './settings.js';
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

export function App({ api: injectedApi }: { api?: ApiClient } = {}) {
  const { ready, viewer, theme } = useBlockContext();
  const token = useBlockToken();
  const settings = useBlockSettings();
  const { requestSignIn } = useRequestSignIn();
  const isMobile = useIsMobile();
  const toasts = useToasts();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  const c = palette(theme === 'dark');
  const player = useMemo(() => resolveSettings(settings), [settings]);

  // Real HTTP client (prod) unless a fake is injected (tests/dev).
  const realApi = useMemo(
    () =>
      createHttpApiClient({
        baseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
        getToken: () => token.raw,
        refreshToken: () => token.refresh(),
      }),
    [token],
  );
  const api = injectedApi ?? realApi;

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
  const [balance, setBalance] = useState<number | null>(null);

  // Known-collection lookup (for resolving popular ids to cards).
  const known = useMemo(() => {
    const map = new Map<number, CollectionSummary>();
    for (const s of discover.items) map.set(s.id, s);
    for (const s of mine.items) map.set(s.id, s);
    return map;
  }, [discover.items, mine.items]);

  // ---- loaders ----
  const loadDiscover = useCallback(async () => {
    setDiscover((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await api.listCollections({ mode: 'public', query: search, sort, limit: PAGE_LIMIT });
      setDiscover({ items: page.items, loading: false, error: null });
    } catch (err) {
      setDiscover({ items: [], loading: false, error: errMessage(err) });
    }
  }, [api, search, sort]);

  const loadMine = useCallback(async () => {
    if (!viewer) {
      setMine({ items: [], loading: false, error: null });
      return;
    }
    setMine((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await api.listCollections({ mode: 'mine', query: search, sort, limit: PAGE_LIMIT });
      setMine({ items: page.items, loading: false, error: null });
    } catch (err) {
      setMine({ items: [], loading: false, error: errMessage(err) });
    }
  }, [api, viewer, search, sort]);

  const loadPopular = useCallback(async () => {
    try {
      const entries = await api.getPopular(POPULAR_LIMIT);
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
  }, [api, known]);

  const loadBalance = useCallback(async () => {
    if (!viewer) return;
    try {
      const b = await api.getBuzzBalance();
      setBalance(b.balance);
    } catch {
      setBalance(null);
    }
  }, [api, viewer]);

  // ---- effects ----
  useEffect(() => {
    if (!ready) return;
    void loadDiscover();
  }, [ready, loadDiscover]);

  useEffect(() => {
    if (!ready) return;
    if (tab === 'mine') void loadMine();
  }, [ready, tab, loadMine]);

  useEffect(() => {
    if (!ready) return;
    void loadBalance();
  }, [ready, loadBalance]);

  // Recompute the popular rail whenever the known-collections map changes.
  useEffect(() => {
    if (!ready) return;
    void loadPopular();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, known]);

  // ---- open a collection into the player (+ increment shared play-count) ----
  const openCollection = useCallback(
    async (summary: CollectionSummary) => {
      setOpenLoading(true);
      setOpen(null);
      try {
        const page = await api.getCollection(summary.id, { limit: 200 });
        setOpen({ detail: page.collection, items: page.items, followed: page.collection.followed });
        // Fire-and-forget the play-count bump; a failure never blocks playback.
        api
          .incrementPlayCount(summary.id)
          .then(() => loadPopular())
          .catch(() => {});
      } catch (err) {
        toasts.push('error', errMessage(err));
      } finally {
        setOpenLoading(false);
      }
    },
    [api, loadPopular, toasts],
  );

  const exitPlayer = useCallback(() => setOpen(null), []);

  // ---- follow toggle (optimistic + rollback) ----
  const toggleFollow = useCallback(async () => {
    if (!open) return;
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
        void loadBalance();
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
    [viewer, api, requestSignIn, toasts, loadBalance],
  );

  // ---- render ----
  if (!ready) {
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
          settings={player}
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
            <option value="name">Name</option>
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
