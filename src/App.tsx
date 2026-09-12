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
//
// 🔴 EVERY APP ROOT BELOW CARRIES `data-pc-skin` AS WELL AS `data-theme`, and it
// is not decorative. src/skin.css (`brandDepth: skin`, operator feedback round 3
// item 5) redefines the `--civitai-color-*` VALUES under
// `[data-pc-skin][data-theme…]` — a compound selector, because a bare one would
// tie with @civitai/theme's own `[data-theme='dark']` and lose on source order.
// Drop the attribute from a root and that root silently reverts to the platform's
// blue with no error anywhere; src/skinRoot.test.tsx is what stops that.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { nextIndex, rovingAction } from './lib/roving.js';

import {
  useAppStorage,
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
  Button,
  Card,
  Group,
  Loader,
  Stack,
  TextInput,
  injectBlocksStyles,
} from '@civitai/blocks-react/ui';

import { ApiError, createHttpApiClient, type ApiClient } from './lib/api.js';
import { createCachedApiClient, type CachedApiClient } from './lib/cache.js';
import { readPopular, recordPlay, resolvePopularEntries, summaryFromPage, totalBuzz, type ResolvedPopular } from './lib/popular.js';
import { MAX_DETAIL_PAGES, loadCollectionFirstPage, loadMoreItems } from './lib/collection-loader.js';
import { DEFAULT_RETRY, withBoundedRetry, type RetryConfig } from './lib/retry.js';
import { usePlayerSettings } from './settings.js';
import {
  COLLECTION_PERIODS,
  PERIOD_LABEL,
  PERIOD_TESTID,
  endOfResultsLabel,
  sortHint,
  windowFallbackNotice,
} from './lib/period.js';
import { useBrowsePrefs } from './lib/browse-prefs.js';
import { useDebouncedValue } from './lib/use-debounced-value.js';
import { useServerTipAllowance } from './lib/tip-allowance.js';
import { buildShareUrl, decodeDeepLink, encodeDeepLink } from './lib/deep-link.js';
import { shareLink } from './lib/share.js';
import { DEFAULT_VIEW_MODE, type ViewMode } from './view-modes.js';
import {
  BUZZ_READ_SELF,
  COLLECTIONS_READ_PRIVATE,
  SOCIAL_TIP_SELF,
  defaultHasPrivateScope,
  defaultHasTipScope,
} from './scopes.js';
import { palette } from './theme.js';
import { BrandMark } from './components/BrandMark.js';
import { paintTheme } from './bootTheme.js';
import { useIsMobile } from './useMediaQuery.js';
import type {
  CollectionDetail,
  CollectionSummary,
  MediaItem,
} from './types.js';
import { CollectionGrid, PopularRail, RecentRail } from './components/CollectionGrid.js';
import { useRecent, type RecentEntry } from './lib/recent.js';
import { useAnalytics, type AnalyticsSink } from './lib/analytics.js';
import { CollectionViewer } from './components/CollectionViewer.js';
import type { TipTarget } from './lib/tip-target.js';
import type { PlannedLeg } from './components/TipSplitModal.js';
import { ToastHost, useToasts } from './components/toast.js';

const POPULAR_LIMIT = 10;
const PAGE_LIMIT = 24;
/** Debounce for the live type-ahead search (ms). */
const SEARCH_DEBOUNCE_MS = 300;

type Tab = 'discover' | 'mine';

const TAB_PANEL_ID = 'collection-tabpanel';
const TABS: ReadonlyArray<{ key: Tab; label: string; testid: string }> = [
  { key: 'discover', label: 'Discover', testid: 'tab-discover' },
  { key: 'mine', label: 'My collections', testid: 'tab-mine' },
];

interface ListState {
  items: CollectionSummary[];
  loading: boolean;
  error: string | null;
  /** Cursor for the next page; undefined when the list is fully loaded. */
  nextCursor?: string;
  /** A next-page (infinite-scroll) fetch is in flight. */
  loadingMore: boolean;
  /**
   * Set when the server could not serve the popularity window that was asked
   * for, so the UI can say so instead of presenting all-time as "this month".
   * Derived from the page's provenance by `windowFallbackNotice` — never from
   * the bare presence of `sourceReason`, which a healthy AllTime request sets.
   */
  notice?: string | null;
}

const EMPTY_LIST: ListState = { items: [], loading: false, error: null, nextCursor: undefined, loadingMore: false, notice: null };

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
  /**
   * Predicate over the current block-token scopes deciding whether the viewer has
   * granted `social:tip:self`. Defaults to the real check. Same test-seam shape as
   * `isPrivateGranted`, and needed for the same reason: the mock host models
   * consent for one scope, so a test maps that onto the tip grant to drive the
   * real press -> REQUEST_CONSENT -> re-mint -> picker-opens round trip.
   */
  isTipGranted?: (tokenScopes: string[]) => boolean;
  /** Bounded-retry config for the auto-run data loaders (test seam). */
  retry?: RetryConfig;
  /** Analytics sink (Feature #10). A test injects one; prod plugs a transport. */
  onEvent?: AnalyticsSink;
}

export function App({ api: injectedApi, isPrivateGranted, isTipGranted, retry = DEFAULT_RETRY, onEvent }: AppProps = {}) {
  const { ready, viewer, theme } = useBlockContext();
  const token = useBlockToken();
  const host = useHostOrigin();
  const { requestSignIn } = useRequestSignIn();
  const { requestConsent } = useRequestConsent();
  const isMobile = useIsMobile();
  const toasts = useToasts();

  // Buzz balance via the host-mediated GET_BUZZ_BALANCE bridge —
  // NOT a block HTTP endpoint (the old `/api/v1/blocks/buzz` was retired by
  // civitai #3144).
  //
  // 🔴 "(scope-free)" USED TO BE WRITTEN HERE AND IS NO LONGER TRUE. The host's
  // `blocks.getMyBuzzBalance` now throws FORBIDDEN unless the block token carries
  // `buzz:read:self` (civitai/civitai#4745, live 2026-09-10). It is in our manifest,
  // so we are fine — but the word "scope-free" is what made a wrong diagnosis
  // plausible for a day, so it is corrected rather than deleted. See `scopes.ts`
  // for what the missing balance line does and does not tell you.
  //
  // Returns per-pool { blue, green, yellow }; we sum to one
  // spendable figure for the tip modal's soft ceiling. 🔴 That is now its ONLY
  // consumer — the header pill that also showed it was removed 2026-09-05 — so
  // this hook looks unused at a glance and is not. See the note at the header.
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

  // Recently-played collections (Feature #7) — the "Continue watching" rail.
  const { recent, record: recordRecentPlay } = useRecent();

  // Product analytics (Feature #10).
  const analytics = useAnalytics(onEvent);
  const prevModeRef = useRef<ViewMode | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  // Refs to the Discover/Mine tab buttons for roving-focus keyboard nav (#4).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Theme colors resolve to `--civitai-*` tokens (theme-agnostic); light/dark is
  // driven by the `data-theme` attribute set on the app root below, not by JS.
  const c = palette();
  // 🔴 NEVER the bare `theme` here. Before `ready` the SDK's snapshot hardcodes the
  // string 'light' (blocks-react dist/internal/transport.js, EMPTY_SNAPSHOT), so
  // `theme === 'dark' ? 'dark' : 'light'` resolved every pre-init viewer to LIGHT —
  // repainting index.html's dark boot skeleton white, then dark again at BLOCK_INIT.
  // After `ready` the host's answer wins outright, exactly as before. See
  // src/bootTheme.ts.
  const dataTheme = paintTheme(ready, theme);

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

  // Can this token actually send a tip? See `scopes.ts` for why this is keyed on
  // `social:tip:self` alone even though the request below asks for both.
  const hasTipScope = (isTipGranted ?? defaultHasTipScope)(token.scopes ?? []);

  /**
   * The viewer pressed Tip without the grant that makes tipping possible.
   *
   * 🔴 THIS IS WHY THE PRESS MUST NOT OPEN THE PICKER. Without `social:tip:self`
   * the server refuses every leg at the scope gate, so the picker can only walk a
   * viewer through choosing a recipient and an amount and then tell them "not
   * sent" with no route to fix it — which is exactly what a real 2-Buzz tip did on
   * 2026-09-08. Asking for the grant is the only action that can succeed, so it is
   * the one the press performs.
   *
   * Both scopes are requested together: tipping is the point, and a picker that
   * cannot show a balance is a degraded one. Fire-and-forget, like the private
   * request above — on grant the host re-mints and pushes TOKEN_REFRESH, which
   * flips `hasTipScope`; declined changes nothing and raises no error.
   */
  const requestTipConsent = useCallback(() => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    requestConsent({ scopes: [SOCIAL_TIP_SELF, BUZZ_READ_SELF] });
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
  const realApi = useMemo<CachedApiClient | null>(
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
  /**
   * The client to drop cached reads on after a follow write.
   *
   * 🔴 KEYED ON CAPABILITY, NOT ON PROVENANCE — and that distinction is the
   * whole reason this guard is testable. It was `injectedApi ? null : realApi`,
   * which read reasonably (only the real client is cache-wrapped) and had one
   * fatal consequence an audit found: EVERY test injects a client, so
   * `cachedApi` was ALWAYS null under test and `invalidateReads()` never
   * executed in any suite. The call could be deleted outright and the whole
   * suite stayed green — on the one obligation this release newly created, and
   * which `lib/cache.ts` itself warns "is easy to miss".
   *
   * Asking whether the client can invalidate lets a test inject one that can.
   */
  const cachedApi =
    api && typeof (api as Partial<CachedApiClient>).invalidateReads === 'function'
      ? (api as CachedApiClient)
      : null;
  // Data-fetching is gated on a usable client (injected fake, or the real client
  // once host+token are established).
  const canFetch = api != null;

  // The viewer's REAL remaining daily tip allowance — ONE read for the whole
  // view, threaded down to the ONE tip affordance (`chrome-tip`, which opens
  // the one picker — there were four before T5) and re-read
  // after each successful transfer.
  //
  // 🔴 THIS REPLACED A localStorage RUNNING TOTAL THAT COULD NEVER WORK (0.2.10).
  // The old `useDailyTipAllowance` derived "remaining" from a per-device counter
  // that (a) throws in the opaque-origin sandbox, so the estimate was always the
  // full cap and tracked nothing, and (b) counted only tips made through THIS app
  // on THIS device even where it did persist. `getTipAllowance()` is the server's
  // own figure over the same bearer + scope the app already holds to tip.
  const tipAllowance = useServerTipAllowance(api);

  // ---- browse state ----
  const [tab, setTab] = useState<Tab>('discover');
  const [search, setSearch] = useState('');
  // Live type-ahead: the input updates on every keystroke, but the list only
  // re-fetches off this debounced value — no explicit Enter/Search needed. The
  // loaders below read `debouncedSearch`, so they're re-created (and the browse
  // effects re-run) ~300 ms after typing stops, not on each keystroke.
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  // ---- the two persisted discovery controls ----
  //
  // The sort defaults to Popular (feedback #3) and the window to Month
  // (criterion 1). On the wire the sort becomes the deployed server's
  // `Most Followers` (CollectionSort.MostContributors) via SORT_PARAM in
  // lib/api.ts — no dependency on any undeployed server enum.
  //
  // 🔴 BOTH PERSIST, THROUGH ONE MECHANISM, BY DESIGN. They used to be two plain
  // `useState`s that agreed by both persisting NOTHING, with a comment here
  // asking the operator to decide whether both should survive a reload. They
  // should. `lib/browse-prefs.ts` writes them as a single record to a single
  // app-storage key, so there is no way to give one a mechanism the other lacks
  // — which is the drift `App.test.tsx`'s relationship guard exists to catch.
  //
  // 🔴 It is NOT localStorage, and the reason is in `lib/browse-prefs.ts`: this
  // iframe has an opaque origin, so the SDK's web-storage shim is in-memory and
  // SESSION-SCOPED. A localStorage key would have tested green and persisted
  // nothing in production.
  //
  // 🔴 THE FIRST RENDER DOES NOT WAIT FOR THE STORED RECORD. The grid paints on
  // the defaults and swaps when the read lands, which costs a viewer with a
  // NON-default stored record one extra list request. The alternative — holding
  // the first fetch until prefs resolve — needed a deadline timer, a `hydrated`
  // flag, a race guard and two gated effect dependency arrays, and it put a
  // viewer's stored record one slow host away from being overwritten.
  const appStorage = useAppStorage();
  const { prefs: browsePrefs, setSort, setPeriod } = useBrowsePrefs(appStorage, { enabled: ready });
  const { sort, period } = browsePrefs;
  // 🔴 THE WINDOW IS A PUBLIC-DISCOVERY CONCEPT, AND IT IS SENT IN EXACTLY ONE
  // PLACE: the public feed, on the popularity sort. Both exclusions are measured,
  // not assumed — the server reports a distinct reason for each:
  //   - `sort=Newest&period=Week`  -> `period-ignored-for-non-popularity-sort`
  //   - `mode=mine&period=Month`   -> `period-ignored-outside-public-discovery`
  // In both cases the param changes nothing and the response comes back
  // `source: 'postgres'`, which at the consumer is INDISTINGUISHABLE from
  // ClickHouse being down. Sending it anyway would have hung a false "ranking
  // isn't available right now" note under the Mine tab permanently.
  //
  // Keeping it `undefined` also keeps the loader deps below from re-fetching
  // when the (hidden) period changes on a surface that does not use it.
  const discoverPeriod = sort === 'popular' ? period : undefined;
  // What the UI may CLAIM is in effect. The loaders above are per-MODE and both
  // run regardless of which tab is showing; this is per-TAB, because the hint,
  // the control and the end-of-list line all describe the tab in front of you.
  const activePeriod = tab === 'discover' ? discoverPeriod : undefined;
  const [discover, setDiscover] = useState<ListState>({ ...EMPTY_LIST, loading: true });
  const [mine, setMine] = useState<ListState>(EMPTY_LIST);
  const [popular, setPopular] = useState<ResolvedPopular[]>([]);

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
  const [tipping, setTipping] = useState(false);
  // Synchronous double-tip guard. `setTipping(true)` only disables the button on
  // the NEXT render; a fast double-click can fire two `doTip` calls before that
  // commits. This ref gates the second call in the same tick (see doTip).
  const tipInFlightRef = useRef(false);
  // A failed collection-open keeps a retry affordance (the grid already has one).
  const [openError, setOpenError] = useState<{ summary: CollectionSummary; message: string } | null>(null);

  /**
   * Split-tip PLANS, keyed by logical tip (`splitTipKey`).
   *
   * 🔴 THEY LIVE HERE BECAUSE EVERY COMPONENT BELOW GETS UNMOUNTED BY ORDINARY
   * USE. The plan holds the whole double-spend defence — one idempotency key per
   * leg, minted once, plus the `sent` markers a retry skips on. It used to be
   * `useState` inside TipSplitModal, which the popover's own **Close** button
   * destroys; the viewer then reopened, confirmed, and the already-landed leg was
   * transferred a SECOND time under a fresh key the server had never seen, so it
   * could not collapse the replay. (Measured: creator paid 50 for a 25 press,
   * allowance debited 75 for a 50 tip.) Closing the popover, switching view mode,
   * opening or closing the lightbox and leaving the collection all unmount a
   * Player — App is the lowest owner that survives all four.
   *
   * A completed tip is DELETED (its keys can never be needed again), so this only
   * ever holds plans that half-failed, which is a handful at most.
   */
  const [splitPlans, setSplitPlans] = useState<Record<string, PlannedLeg[]>>({});
  const onSplitPlanChange = useCallback((key: string, plan: PlannedLeg[] | null) => {
    setSplitPlans((prev) => {
      if (plan == null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: plan };
    });
  }, []);

  // Deep-link (Feature #6): the open collection + mode + index live in the URL
  // hash so a reload restores playback and Share hands out a link.
  const [viewState, setViewState] = useState<{ mode: ViewMode; index: number }>({ mode: DEFAULT_VIEW_MODE, index: 0 });
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const [deepLinkRestore, setDeepLinkRestore] = useState<{ id: number; mode: ViewMode; index: number } | null>(null);
  const autoOpenedRef = useRef(false);

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
        () => api.listCollections({ mode: 'public', query: debouncedSearch, sort, period: discoverPeriod, limit: PAGE_LIMIT }),
        retry,
      );
      setDiscover({
        items: page.items,
        loading: false,
        error: null,
        nextCursor: page.nextCursor,
        loadingMore: false,
        notice: windowFallbackNotice(discoverPeriod, page),
      });
    } catch (err) {
      setDiscover({ ...EMPTY_LIST, error: errMessage(err) });
    }
  }, [api, debouncedSearch, sort, discoverPeriod, retry]);

  const loadMine = useCallback(async () => {
    if (!api) return;
    if (!viewer) {
      setMine(EMPTY_LIST);
      return;
    }
    setMine((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await withBoundedRetry(
        () => api.listCollections({ mode: 'mine', query: debouncedSearch, sort, limit: PAGE_LIMIT }),
        retry,
      );
      setMine({
        items: page.items,
        loading: false,
        error: null,
        nextCursor: page.nextCursor,
        loadingMore: false,
        // The mine feed never asks for a window, so there is never one to miss.
        notice: null,
      });
    } catch (err) {
      setMine({ ...EMPTY_LIST, error: errMessage(err) });
    }
  }, [api, viewer, debouncedSearch, sort, retry]);

  // Infinite-scroll page loaders (feedback #1): fetch the next page via the
  // stored `nextCursor` and append, deduping the inclusive-cursor re-emit.
  const loadMoreDiscover = useCallback(async () => {
    if (!api) return;
    const s = discoverRef.current;
    if (!s.nextCursor || s.loadingMore) return;
    const cursor = s.nextCursor;
    setDiscover((p) => ({ ...p, loadingMore: true }));
    try {
      const page = await api.listCollections({ mode: 'public', query: debouncedSearch, sort, period: discoverPeriod, cursor, limit: PAGE_LIMIT });
      setDiscover((p) => ({
        ...p,
        items: mergeSummaries(p.items, page.items),
        nextCursor: page.nextCursor,
        loadingMore: false,
        // The newest page's provenance wins: a mid-scroll fallback is still a
        // fallback, and a page that recovered should clear a stale notice.
        notice: windowFallbackNotice(discoverPeriod, page),
      }));
    } catch {
      setDiscover((p) => ({ ...p, loadingMore: false }));
    }
  }, [api, debouncedSearch, sort, discoverPeriod]);

  const loadMoreMine = useCallback(async () => {
    if (!api || !viewer) return;
    const s = mineRef.current;
    if (!s.nextCursor || s.loadingMore) return;
    const cursor = s.nextCursor;
    setMine((p) => ({ ...p, loadingMore: true }));
    try {
      const page = await api.listCollections({ mode: 'mine', query: debouncedSearch, sort, cursor, limit: PAGE_LIMIT });
      setMine((p) => ({
        ...p,
        items: mergeSummaries(p.items, page.items),
        nextCursor: page.nextCursor,
        loadingMore: false,
        notice: null,
      }));
    } catch {
      setMine((p) => ({ ...p, loadingMore: false }));
    }
  }, [api, viewer, debouncedSearch, sort]);

  const loadPopular = useCallback(async () => {
    try {
      const entries = await readPopular(shared, POPULAR_LIMIT);
      // Resolve each ranked entry to a full card. An id already on a loaded list
      // is used directly; an id that ISN'T (a popular collection not on the
      // current page) is fetched by id so the rail always shows the true top-N
      // (v0.1.9 fix). A resolve failure drops that one entry, never the rail.
      const resolved = await resolvePopularEntries(entries, known, async (id) => {
        if (!api) return null;
        try {
          const page = await api.getCollection(id, { limit: 1 });
          return summaryFromPage(page);
        } catch {
          return null;
        }
      });
      setPopular(resolved);
    } catch {
      // Popular is a nice-to-have; never block the page on it.
      setPopular([]);
    }
  }, [shared, known, api]);

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
      setOpenError(null);
      prevModeRef.current = null; // reset mode-switch tracking for the new collection
      try {
        const page = await loadCollectionFirstPage(api, summary.id);
        setOpen({
          detail: page.collection,
          items: page.items,
          followed: page.collection.followed,
          nextCursor: page.nextCursor,
          pages: 1,
        });
        analytics.track({ type: 'play', collectionId: summary.id });
        // Add to the device-local "Continue watching" rail (#7).
        recordRecentPlay({ id: summary.id, name: summary.name, coverImageUrl: summary.coverImageUrl, coverNsfwLevel: summary.coverNsfwLevel });
        // Fire-and-forget the shared play-count vote; a failure never blocks
        // playback (anon viewers reject on the write path — that's fine).
        recordPlay(shared, summary)
          .then(() => loadPopular())
          .catch(() => {});
      } catch (err) {
        // Keep a retry affordance (the grid has one for the list; this covers the
        // open path, which previously only flashed a transient toast).
        setOpenError({ summary, message: errMessage(err) });
      } finally {
        setOpenLoading(false);
      }
    },
    [api, shared, loadPopular, recordRecentPlay, analytics],
  );

  const retryOpen = useCallback(() => {
    if (openError) void openCollection(openError.summary);
  }, [openError, openCollection]);

  // Open a collection by id (deep-link restore): fetch its first page, then open.
  const openById = useCallback(
    async (id: number) => {
      if (!api) return;
      setOpenLoading(true);
      setOpen(null);
      setOpenError(null);
      prevModeRef.current = null;
      try {
        const page = await loadCollectionFirstPage(api, id);
        setOpen({ detail: page.collection, items: page.items, followed: page.collection.followed, nextCursor: page.nextCursor, pages: 1 });
        const s = summaryFromPage(page);
        analytics.track({ type: 'play', collectionId: s.id });
        recordRecentPlay({ id: s.id, name: s.name, coverImageUrl: s.coverImageUrl, coverNsfwLevel: s.coverNsfwLevel });
        recordPlay(shared, s)
          .then(() => loadPopular())
          .catch(() => {});
      } catch (err) {
        // Minimal summary so the generic retry (needs only .id) still works.
        const summary: CollectionSummary = {
          id,
          name: 'this collection',
          description: null,
          coverImageUrl: null,
          itemCount: 0,
          curator: { userId: 0, username: null },
          isPublic: true,
          followed: false,
        };
        setOpenError({ summary, message: errMessage(err) });
      } finally {
        setOpenLoading(false);
      }
    },
    [api, shared, loadPopular, recordRecentPlay, analytics],
  );

  // Reopen a recently-played collection (#7). Reuses the id-based open; the saved
  // mode+position are restored by CollectionViewer's loadCollectionState.
  const openRecent = useCallback(
    (entry: RecentEntry) => {
      const summary: CollectionSummary = {
        id: entry.id,
        name: entry.name,
        description: null,
        coverImageUrl: entry.coverImageUrl,
        itemCount: 0,
        curator: { userId: 0, username: null },
        isPublic: true,
        followed: false,
        coverNsfwLevel: entry.coverNsfwLevel,
      };
      void openCollection(summary);
    },
    [openCollection],
  );

  // Restore from the URL hash ONCE, when data-fetching becomes possible.
  useEffect(() => {
    if (!ready || !canFetch || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    const dl = decodeDeepLink(typeof window !== 'undefined' ? window.location.hash : null);
    if (dl) {
      setDeepLinkRestore({ id: dl.collectionId, mode: dl.mode, index: dl.index });
      setViewState({ mode: dl.mode, index: dl.index });
      void openById(dl.collectionId);
    }
  }, [ready, canFetch, openById]);

  // Keep the URL hash in sync with the open collection + view state (no reload).
  // 🔴 Don't clear the hash until the auto-open one-shot has consumed it — this
  // effect runs on the pre-`ready` renders too, and clearing there would wipe the
  // deep link before restore could read it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const { pathname, search } = window.location;
    if (open) {
      const hash = encodeDeepLink({ collectionId: open.detail.id, mode: viewState.mode, index: viewState.index });
      window.history.replaceState(null, '', `${pathname}${search}#${hash}`);
    } else if (autoOpenedRef.current && window.location.hash) {
      window.history.replaceState(null, '', `${pathname}${search}`);
    }
  }, [open, viewState]);

  // Share the current collection + position (Web Share sheet / copy-link).
  const onShareCollection = useCallback(async () => {
    const o = openRef.current;
    if (!o || typeof window === 'undefined') return;
    const url = buildShareUrl(window.location.href, {
      collectionId: o.detail.id,
      mode: viewStateRef.current.mode,
      index: viewStateRef.current.index,
    });
    analytics.track({ type: 'share', collectionId: o.detail.id });
    const result = await shareLink({ title: o.detail.name, text: `Play "${o.detail.name}" on Civitai`, url });
    if (result.method === 'copy' && result.ok) toasts.push('success', 'Link copied to clipboard.');
    else if (result.method === 'none') toasts.push('info', `Share link: ${url}`);
  }, [toasts, analytics]);

  // Track a view-mode switch (skip the initial report per opened collection).
  const handleViewStateChange = useCallback(
    (s: { mode: ViewMode; index: number }) => {
      setViewState(s);
      if (prevModeRef.current != null && s.mode !== prevModeRef.current) {
        const id = openRef.current?.detail.id;
        if (id != null) analytics.track({ type: 'mode_switch', collectionId: id, mode: s.mode });
      }
      prevModeRef.current = s.mode;
    },
    [analytics],
  );

  // Open a collection from the Popular rail (tracks popular_open, then opens).
  const openPopular = useCallback(
    (summary: CollectionSummary) => {
      analytics.track({ type: 'popular_open', collectionId: summary.id });
      void openCollection(summary);
    },
    [analytics, openCollection],
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

  const applyFollowedToLists = useCallback((id: number, followed: boolean) => {
    const patch = (s: ListState): ListState => ({
      ...s,
      items: s.items.map((it) => (it.id === id ? { ...it, followed } : it)),
    });
    setDiscover(patch);
    setMine(patch);
  }, []);

  // ---- follow: adopt the host's echo ----
  //
  // 🔴 THE OPTIMISTIC-FLIP-AND-ROLLBACK BLOCK THAT LIVED HERE IS GONE, AND ITS
  // REMOVAL IS THE POINT (0.2.10). Following runs through the host-mediated
  // `SET_COLLECTION_FOLLOW` bridge now, so the write, the optimism, the rollback
  // and the sign-in bounce all belong to the control that owns the request
  // (upstream `FollowButton`, which since T5 is the ONE follow control in all
  // three views).
  // App keeps only what is genuinely app state: the flag, the two lists that
  // render a badge from it, and the analytics event.
  //
  // 🔴 The old block treated EVERY rejection as an error toast, which the bridge
  // makes wrong: dismissing the host's consent dialog rejects with `declined`,
  // and the viewer who just chose "no" would have been told the app failed.
  const onFollowChange = useCallback(
    (collectionId: number, followed: boolean) => {
      // 🔴 THE ID COMES FROM THE HOST'S ECHO, NOT FROM `openRef`. This used to
      // read `openRef.current?.detail.id` and bail when it was null, which was
      // wrong in two ways an audit found. The reply lands after a round trip
      // PLUS the time the viewer spends in the host consent dialog, and the
      // viewer can navigate in that window:
      //   - exit the player first  -> `openRef` is null -> the whole handler
      //     returned early, so a follow that DID land produced no badge and no
      //     cache drop, and looked to the viewer like it silently failed;
      //   - open a DIFFERENT collection first -> `openRef` names the new one, so
      //     the analytics event and the list patch were applied to a collection
      //     the viewer never followed.
      // Keyed on the echo, both cases are attributed correctly and neither
      // depends on what is open now.

      // 🔴 INVALIDATE FIRST — before any early return. `followed` is embedded in
      // both the cached list and detail payloads, the cache wrapper used to do
      // this by intercepting `api.setFollow`, and the bridge never touches the
      // client. Ordering it after an `open`-dependent guard is what made a
      // real write serve a stale flag for the 5-minute TTL.
      cachedApi?.invalidateReads();
      analytics.track({ type: 'follow', collectionId, followed });
      // Keep the grid card badge in sync.
      applyFollowedToLists(collectionId, followed);
      // Only touch the OPEN collection's own flag, and only if it is still the
      // one that was written.
      setOpen((o) => (o && o.detail.id === collectionId ? { ...o, followed } : o));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analytics, applyFollowedToLists, cachedApi],
  );

  // 🔴 THE AMBIGUOUS-OUTCOME CACHE DROP THAT STOOD HERE IS GONE, AND ITS ABSENCE
  // IS A KNOWN GAP RATHER THAN A CLEANUP (T5). `onFollowUncertain` dropped the
  // cached reads when a follow TIMED OUT or came back as a code-less server error
  // — either of which can be raised AFTER the row committed — so the app's own
  // "check the collection in a moment" advice was not answered by the 5-minute
  // cache with the PRE-follow flag. It was fed by `useFollowToggle`, the app's
  // hand-rolled follow control, which T5 replaced with upstream `FollowButton` so
  // that all three views share one control. `FollowButton` reports only SUCCESS
  // (`onChange`); it exposes no failure or timeout callback, so this app can no
  // longer learn that an outcome was ambiguous.
  //
  // Exposure: a stale `followed` flag for the cache TTL after an ambiguous write.
  // No money, no writes, and the invalidation on a CONFIRMED follow below is
  // untouched. The fix is an upstream prop on `FollowButton`, not a second follow
  // implementation here.

  // ---- tip flow ----
  const doTip = useCallback(
    async (target: TipTarget, amount: number, idempotencyKey?: string): Promise<boolean> => {
      // Synchronous double-tip gate (M1): reject a second call that arrives in the
      // same tick, before `setTipping(true)`'s re-render can disable the button.
      if (tipInFlightRef.current) return false;
      if (!api) return false;
      if (!viewer) {
        requestSignIn();
        return false;
      }
      tipInFlightRef.current = true;
      setTipping(true);
      try {
        const result = await api.tip({
          toUserId: target.toUserId,
          amount,
          entityType: target.entityType,
          entityId: target.entityId,
          // Passed through verbatim. The split popover mints one key per leg and
          // reuses it on retry; the server replays the first terminal result for
          // a repeated key, which is what makes retrying a half-failed split safe.
          idempotencyKey,
        });
        // A non-throwing soft-failure (`{ ok: false }`) must NOT count as success —
        // no allowance debit, no success toast, no optimistic "tipped" state.
        if (!result?.ok) {
          toasts.push('error', 'That tip could not be completed. Please try again.');
          return false;
        }
        // Use the SERVER's committed figure (O2), not the client amount — the two
        // can diverge (host clamping / rounding). Fall back to the requested amount.
        const sent = result.tip?.amount ?? amount;
        // Re-read the SERVER's allowance so the next picker opens on the real
        // remaining figure. (This is where `tipAllowance.record(sent)` used to
        // add `sent` to a localStorage running total that tracked nothing.)
        tipAllowance.refetch();
        analytics.track({ type: 'tip', kind: target.kind, amount: sent });
        toasts.push('success', `Sent ${sent.toLocaleString()} Buzz to ${target.username ? '@' + target.username : 'the ' + target.kind}.`);
        refetchBalance();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'network') {
          // AMBIGUOUS (M2): a timed-out / dropped tip POST may have ALREADY
          // committed server-side — a "clean" one-click retry risks a double-spend.
          // Warn the viewer to verify their balance before retrying instead.
          //
          // 🔴 STILL THE RIGHT WARNING FOR *THIS* PATH, even though the
          // idempotency key it was waiting on now exists (0.2.10). The key only
          // helps a retry that REUSES it, and the single-target picker has no
          // retry affordance — the viewer re-opens the modal, which is a NEW
          // logical tip and mints nothing to replay. The split popover, which
          // does own its retry, carries the key and is safe to press again.
          toasts.push('info', 'This tip may have gone through — check your Buzz balance before retrying.');
        } else if (err instanceof ApiError && err.code === 'insufficient_balance') {
          toasts.push('error', "You don't have enough Buzz for that tip.");
        } else if (err instanceof ApiError && err.code === 'rate_limited') {
          // Surface the server's Retry-After (daily-cap / burst back-off) when present.
          const secs = err.retryAfterMs != null ? Math.ceil(err.retryAfterMs / 1000) : null;
          toasts.push(
            'error',
            secs != null
              ? `You've hit your tip limit — try again in ${secs}s.`
              : "You've hit your tip limit — please slow down before tipping again.",
          );
        } else {
          toasts.push('error', errMessage(err));
        }
        return false;
      } finally {
        tipInFlightRef.current = false;
        setTipping(false);
      }
    },
    [viewer, api, requestSignIn, toasts, refetchBalance, tipAllowance, analytics],
  );

  // ---- render ----
  // Boot gate: wait for BLOCK_INIT (ready) AND a usable client (host origin +
  // token established, or an injected fake). Until then, show loading — never
  // fetch, so the same-origin/no-host loop can't start.
  if (!ready || !canFetch) {
    return (
      <div ref={rootRef} data-pc-skin data-theme={dataTheme} style={pageStyle()}>
        <div style={{ margin: 'auto', display: 'flex', gap: 10, alignItems: 'center', color: 'var(--civitai-color-text-dimmed)' }}>
          <Loader size="sm" />
          Loading Playable Collections…
        </div>
      </div>
    );
  }

  if (open) {
    return (
      <div ref={rootRef} data-pc-skin data-theme={dataTheme}>
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
          onFollowChange={onFollowChange}
          onTip={doTip}
          onRequestSignIn={() => requestSignIn()}
          hasTipScope={hasTipScope}
          onRequestTipConsent={requestTipConsent}
          tipping={tipping}
          // `null` (unresolved / failed read) becomes `undefined`, which is the
          // pickers' "no local pre-block" default. A failed allowance read must
          // never make tipping impossible — the server stays the real gate.
          dailyTipRemaining={tipAllowance.remaining ?? undefined}
          splitPlans={splitPlans}
          onSplitPlanChange={onSplitPlanChange}
          onShare={onShareCollection}
          onCast={(on) => analytics.track({ type: 'cast', on })}
          onViewStateChange={handleViewStateChange}
          initialMode={deepLinkRestore?.id === open.detail.id ? deepLinkRestore.mode : undefined}
          initialIndex={deepLinkRestore?.id === open.detail.id ? deepLinkRestore.index : undefined}
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
  const activeTabId = TABS.find((t) => t.key === tab)?.testid;

  // Roving-focus tablist keyboard handler (ship-blocker #4): Arrow keys / Home /
  // End move selection + focus across the Discover/Mine tabs.
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const action = rovingAction(e.key, 'horizontal');
    if (!action) return;
    e.preventDefault();
    const cur = TABS.findIndex((t) => t.key === tab);
    const target = nextIndex(action, cur, TABS.length);
    const next = TABS[target];
    if (next) {
      setTab(next.key);
      tabRefs.current[target]?.focus();
    }
  };

  return (
    <div ref={rootRef} data-pc-skin data-theme={dataTheme} data-layout={isMobile ? 'mobile' : 'desktop'} style={pageStyle()}>
      <div style={contentStyle}>
        <Stack gap={16}>
          <header style={{ display: 'grid', gap: 6 }}>
            {/* The header carried a "⚡ <balance>" Buzz pill here. Removed
                2026-09-05: a wallet readout is the host's job, not a media
                player's chrome, and it competed with the app's own content.
                🔴 THE BALANCE ITSELF IS DELIBERATELY KEPT — `useBuzzBalance()` +
                `totalBuzz` still run and `balance` is still threaded down to
                the tip picker, which pre-validates a tip against it. Do not "finish the
                cleanup" by deleting the hook. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              {/* The mark, beside the name. Under `accent` the brand lived only in
                  the store assets; `skin` is what earns it a place in the UI. It is
                  aria-hidden — the <h1> already says the name. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <BrandMark />
                <h1 style={{ fontSize: 22, margin: 0 }}>Playable Collections</h1>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--civitai-color-text-dimmed)' }}>
              Sit back and play through a collection's images and videos.
            </p>
          </header>

          {/* failed collection-open → retry affordance (#5) */}
          {openError && (
            <Alert color="error" title="Couldn't open that collection" data-testid="open-error">
              <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                <span>{openError.message}</span>
                <Button size="sm" variant="outline" color="error" onClick={retryOpen} data-testid="open-retry">
                  Try again
                </Button>
              </div>
            </Alert>
          )}

          {/* tabs — WAI-ARIA roving tablist (#4): only the selected tab is
              tabbable; Arrow/Home/End move selection+focus; each tab controls the
              tabpanel below. */}
          <Group gap={8} role="tablist" aria-label="Collection source" onKeyDown={onTabKeyDown}>
            {TABS.map((t, i) => (
              <Button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                id={t.testid}
                role="tab"
                aria-selected={tab === t.key}
                aria-controls={TAB_PANEL_ID}
                tabIndex={tab === t.key ? 0 : -1}
                variant={tab === t.key ? 'filled' : 'light'}
                onClick={() => setTab(t.key)}
                data-testid={t.testid}
              >
                {t.label}
              </Button>
            ))}
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
              </Group>

              {/* Popularity window — rendered only on the popular sort, because
                  that is the only sort the server honours it for (criterion 6).
                  Hiding it beats disabling it: a viewer cannot pick a window
                  under Newest, see nothing change, and have to be told why.
                  The choice is REMEMBERED while hidden, so switching back to
                  Popular restores the window rather than resetting it.

                  Same control pattern as the sort chips above, deliberately
                  (criterion 5): real `<Button>`s in a labelled `role="group"`,
                  each carrying `aria-pressed`. That is natively keyboard
                  operable — every chip is in the tab order, Enter/Space
                  activates. NO roving tabindex: the tabs above use roving
                  because they are `role="tab"` in a tablist, where the ARIA
                  pattern requires it; a group of toggle buttons must not steal
                  Tab from its own members. */}
              {activePeriod != null && (
                <Group gap={8} align="center">
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--civitai-color-text-dimmed)' }}>Popular</span>
                  <Group gap={4} role="group" aria-label="Popularity window" data-testid="period-group">
                    {COLLECTION_PERIODS.map((p) => (
                      <Button
                        key={p}
                        size="sm"
                        variant={period === p ? 'filled' : 'light'}
                        aria-pressed={period === p}
                        onClick={() => setPeriod(p)}
                        data-testid={PERIOD_TESTID[p]}
                      >
                        {PERIOD_LABEL[p]}
                      </Button>
                    ))}
                  </Group>
                </Group>
              )}
              {/* 🔴 OUT OF THE CHIP ROW, AND PHRASED AS A SENTENCE. Sitting inline
                  after the two chips at 12px dimmed, this read as a THIRD, disabled
                  sort option — "Popular | Newest | Most followed" — which is a claim
                  about the control surface, not about the sort. The same string was
                  ALSO the `title` on the Popular button, so it was delivered twice by
                  two mechanisms; that duplicate is gone. A sentence with a full stop
                  cannot be mistaken for a chip. */}
              <span style={{ fontSize: 12, color: 'var(--civitai-color-text-dimmed)' }} data-testid="sort-hint">
                {sortHint(sort, activePeriod)}
              </span>
              {/* 🔴 WHY THIS IS A NOTE AND NOT A REWRITTEN HINT. When the server
                  cannot rank the asked-for window it silently serves the
                  all-time order, and presenting that as "this month" would be a
                  lie the viewer has no way to detect. The two places to say so
                  were the hint line or a note beside it; the note wins because
                  the hint carries a literal an EXTERNAL consumer waits on (see
                  POPULAR_SORT_SENTENCE in lib/period.ts), so keeping the hint
                  deterministic and adding a second element is the option that
                  does not couple a failure path to a capture recipe. The hint
                  therefore always describes the CONTROL's state; this line
                  describes what was actually served. */}
              {activeList.notice && (
                <span
                  role="status"
                  style={{ fontSize: 12, color: 'var(--civitai-color-text-dimmed)' }}
                  data-testid="period-fallback"
                >
                  {activeList.notice}
                </span>
              )}
            </Stack>
          </form>

          {/* the tabpanel the Discover/Mine tabs control (#4) */}
          <div role="tabpanel" id={TAB_PANEL_ID} aria-labelledby={activeTabId} tabIndex={0} style={{ display: 'grid', gap: 16, outline: 'none' }}>
          {/* continue-watching rail (discover only, #7) */}
          {tab === 'discover' && <RecentRail entries={recent} onOpen={openRecent} c={c} />}

          {/* popular rail (discover only) */}
          {tab === 'discover' && <PopularRail entries={popular} onOpen={openPopular} c={c} />}

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
                // Discover only. That is the surface a Month-default window
                // bounds to ~18 pages, and the surface where "the grid just
                // stops" reads as a broken loader. `mine` is a short list whose
                // end has always been obvious, so it keeps today's behaviour.
                endLabel={tab === 'discover' ? endOfResultsLabel(sort, activePeriod) : undefined}
              />
            </>
          )}
          </div>
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
    // 🔴 `body`, not `surface-2`. Under `accent` the choice was arbitrary — the
    // platform's light theme made body/surface/surface-2 the SAME colour, so the
    // page could be any of them, and dark's surface-2 being the lighter value went
    // unnoticed. src/skin.css gives the three tokens three real values in both
    // themes, which turns this into an actual decision: the page is the deepest
    // (`body`), a card is the lift (`surface`), and `surface-2` is a recess for
    // inert chrome (the mode switcher's track, cover placeholders). Leaving it on
    // surface-2 would have made the page the brightest plane and every card a
    // hole in it.
    background: 'var(--civitai-color-body)',
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
