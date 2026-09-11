// Discover / My-collections grid + the cross-user "Popular" rail. Pure
// presentation: it takes already-loaded data and callbacks.
//
// v0.1.5 feedback:
//   #1a INFINITE SCROLL — an IntersectionObserver sentinel at the end of the grid
//       calls `onLoadMore` (the parent threads the list `nextCursor` + appends,
//       deduping by id). No "load more" button; scrolling fetches the next page.
//   #1b LAZY COVERS — a grid-scoped IntersectionObserver swaps each cover's
//       `data-src`→`src` ~150px before it scrolls into view, so a long grid does
//       not fetch every thumbnail up front. (Native `loading="lazy"` does NOT
//       defer reliably inside a scroll container — the SDK's 0.15.3 lesson — so
//       we drive it explicitly.) The null-cover ▶ placeholder tile is kept.
//   #4  RE-SKIN — surfaces are built from `@civitai/blocks-react/ui`
//       (Card / Loader / Alert / Badge / Button); the card itself stays a single
//       clickable control (better a11y than a nested-button Card) hand-styled to
//       the pack idiom via its CSS variables. (See the report's component-pack
//       gap list: a clickable Card + an ImageGrid/lazy-cover primitive.)

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Alert, Badge, Button, Card, Loader } from '@civitai/blocks-react/ui';

import type { CollectionSummary } from '../types.js';
import type { Palette } from '../theme.js';
import type { RecentEntry } from '../lib/recent.js';
import { hasMaturityBadge, withinCeiling } from '../lib/maturity.js';
import { useViewerCeiling } from '../lib/viewer-maturity.js';
import { popularRailEntries } from '../lib/popular.js';
import { MaturityBadge } from './Maturity.js';

/** ~150px prefetch margin so a cover loads just before it enters the viewport. */
const COVER_PREFETCH_MARGIN = '150px';
/** Number of skeleton placeholder cards shown while the first page loads (#10). */
const SKELETON_COUNT = 8;
/** Fire the next-page load a little before the sentinel is fully visible. */
const SENTINEL_MARGIN = '200px';

// A single grid-scoped observer, shared by every CoverImage via context, that
// swaps `data-src`→`src` on intersect. One observer for the whole grid beats one
// per image. `null` when IntersectionObserver is unavailable → covers load eagerly.
type RegisterCover = (img: HTMLImageElement | null) => void;
const CoverObserverContext = createContext<RegisterCover | null>(null);

function swapIn(img: HTMLImageElement) {
  const ds = img.getAttribute('data-src');
  if (ds) {
    img.src = ds;
    img.removeAttribute('data-src');
  }
}

function useCoverObserver(): RegisterCover {
  // Created during render (useMemo) so it exists when child ref callbacks fire
  // at commit — an effect-created observer would still be null then.
  const observer = useMemo(() => {
    if (typeof IntersectionObserver === 'undefined') return null;
    return new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            swapIn(entry.target as HTMLImageElement);
            obs.unobserve(entry.target);
          }
        }
      },
      { rootMargin: COVER_PREFETCH_MARGIN },
    );
  }, []);

  useEffect(() => () => observer?.disconnect(), [observer]);

  return useMemo<RegisterCover>(
    () => (img) => {
      if (!img) return;
      if (!observer) {
        swapIn(img); // no IO support → don't defer
        return;
      }
      observer.observe(img);
    },
    [observer],
  );
}

/**
 * Cover thumbnail with a graceful placeholder. Renders the ▶ placeholder tile
 * when there is no `src`, when the image fails to load (broken/expired URL), AND
 * when the cover's rating is not permitted by the viewer's maturity ceiling — so
 * a card is never blank, never shows a broken-image icon, and never paints an
 * image the platform says this viewer may not see. When a `src` is present and
 * permitted it is loaded LAZILY: the element carries `data-src` until the grid
 * observer swaps it in near the viewport.
 */
export function CoverImage({ src, c, nsfwLevel }: { src: string | null; c: Palette; nsfwLevel?: number }) {
  const register = useContext(CoverObserverContext);
  // Read the ceiling HERE rather than threading it from the three call sites
  // (grid card, popular rail, recent rail): a call site cannot forget it, and
  // `useViewerCeiling` reads the SAME singleton transport snapshot
  // `useBlockContext` does, so a per-card call is a `useSyncExternalStore`
  // subscription to an already-existing store, not new per-card state. (Contrast
  // `CoverObserverContext` above, which IS shared via context because N
  // IntersectionObservers would be N real objects.)
  //
  // 🔴 Must stay ABOVE the `!src` early return — hooks cannot be conditional.
  const ceiling = useViewerCeiling();
  const [failed, setFailed] = useState(false);

  // 🔴 AN OVER-CEILING COVER IS NOT PAINTED AND HAS NO REVEAL. It falls into the
  // same placeholder tile a missing cover uses — the card, its title, its curator
  // and its play affordance all survive, because the COLLECTION is not what the
  // ceiling excluded; one image is.
  //
  // 🔴 THREE DISTINCT COVER STATES, AND COLLAPSING ANY PAIR IS A BUG THIS APP HAS
  // ALREADY SHIPPED ONCE IN EACH DIRECTION (`nsfwLevel ?? 0` blurred every card;
  // a later fix hid every unrated one):
  //
  //   NO COVER      — `coverNsfwLevel` ABSENT and `src` null. `toCoverFields`
  //                   omits the key exactly when `coverImageUrl === null`, so the
  //                   two always travel together. → placeholder, via `!src`.
  //   UNRATED COVER — `coverNsfwLevel === 0`, a real level the server assigned and
  //                   PERMITS at every ceiling. → PAINTED, badged "Unrated".
  //   RATED COVER   — a level bit; painted iff it intersects the ceiling.
  //
  // An absent level arriving WITH a `src` is therefore only possible against a
  // host predating civitai #4663. That is genuine unknowable input, so it is
  // refused — the cover degrades to the placeholder rather than painting an image
  // whose rating nobody stated. `withinCeiling` owns that distinction; the point
  // here is that this branch must not be rewritten as `nsfwLevel ?? 0` or
  // `!nsfwLevel`, either of which re-merges two of the three states.
  if (!src || failed || !withinCeiling(nsfwLevel, ceiling)) {
    return (
      <div style={coverPlaceholder(c)} aria-hidden="true" data-testid="cover-placeholder">
        ▶
      </div>
    );
  }

  const img = (
    // `data-src` (not `src`) is set until the grid observer swaps it in near the
    // viewport — deferring off-screen thumbnail fetches. `register` (via context)
    // adds this <img> to the shared observer.
    // eslint-disable-next-line jsx-a11y/img-redundant-alt
    <img
      ref={register ?? undefined}
      data-src={src}
      alt=""
      style={coverImg}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );

  // The cover is within the ceiling. Label it if it is above PG — a badge on
  // permitted content is information, not a gate, and it hides nothing.
  if (!hasMaturityBadge(nsfwLevel)) return img;

  return (
    <div style={coverBadgeWrap} data-testid="cover-badged">
      {img}
      <span style={coverBadgeSlot}>
        <MaturityBadge nsfwLevel={nsfwLevel} />
      </span>
    </div>
  );
}

/** A single loading-skeleton card (cover + two text lines), theme-token styled. */
export function SkeletonCard() {
  return (
    <div style={cardBtn} data-testid="skeleton-card" aria-hidden="true">
      <div className="pc-skeleton" style={{ ...coverWrap, aspectRatio: '1 / 1' }} />
      <div style={{ ...cardBody, gap: 6 }}>
        <span className="pc-skeleton" style={{ height: 12, borderRadius: 4, width: '80%' }} />
        <span className="pc-skeleton" style={{ height: 10, borderRadius: 4, width: '55%' }} />
      </div>
    </div>
  );
}

export interface CollectionGridProps {
  collections: CollectionSummary[];
  loading: boolean;
  error: string | null;
  emptyLabel: string;
  onOpen: (collection: CollectionSummary) => void;
  onRetry?: () => void;
  c: Palette;
  isMobile: boolean;
  /** Infinite scroll: whether another page exists to fetch. */
  hasMore?: boolean;
  /**
   * What to say once the list has run out of pages. Omit for no end marker.
   *
   * 🔴 THE GRID USED TO END BY RENDERING NOTHING, and that was survivable only
   * because the end was unreachable. The unwindowed popular feed pages the whole
   * corpus; the new Month default is ClickHouse-ranked and bounded — of the top
   * 10,000 ranked collections only ~446 are `Image` type, and this grid shows
   * Image collections only, so the feed ends at ~18 pages at `limit=24`. A grid
   * that simply stops at the bottom of a scroll reads as a broken loader, which
   * is the "looks like the feature is broken" failure this marker prevents.
   *
   * Opt-in per caller rather than automatic: the `mine` tab is a short,
   * unpaginated list where an end banner is noise, and leaving it undefined
   * there keeps that surface byte-identical to today.
   */
  endLabel?: string;
  /** Infinite scroll: a next-page fetch is in flight. */
  loadingMore?: boolean;
  /** Infinite scroll: fetch + append the next page. */
  onLoadMore?: () => void;
}

export function CollectionGrid({
  collections,
  loading,
  error,
  emptyLabel,
  onOpen,
  onRetry,
  c,
  isMobile,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  endLabel,
}: CollectionGridProps) {
  const register = useCoverObserver();

  if (loading && collections.length === 0) {
    // Loading skeleton grid (#10) — placeholder cards instead of a spinner row.
    return (
      <ul style={gridStyle(isMobile)} data-testid="grid-loading" data-layout={isMobile ? 'mobile' : 'desktop'} role="status" aria-label="Loading collections">
        {Array.from({ length: SKELETON_COUNT }, (_, i) => (
          <li key={i} style={{ listStyle: 'none' }}>
            <SkeletonCard />
          </li>
        ))}
      </ul>
    );
  }
  if (error) {
    return (
      <Alert color="error" title="Couldn't load collections" data-testid="grid-error">
        <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <span>{error}</span>
          {onRetry && (
            <Button size="sm" variant="outline" color="error" onClick={onRetry} data-testid="grid-retry">
              Try again
            </Button>
          )}
        </div>
      </Alert>
    );
  }
  if (collections.length === 0) {
    return (
      <Card padding="lg" style={centerNote}>
        <span data-testid="grid-empty" style={{ color: 'var(--civitai-color-text-dimmed)' }}>
          {emptyLabel}
        </span>
      </Card>
    );
  }
  return (
    <CoverObserverContext.Provider value={register}>
      <ul
        style={gridStyle(isMobile)}
        data-testid="collection-grid"
        data-layout={isMobile ? 'mobile' : 'desktop'}
      >
        {collections.map((col) => (
          <li key={col.id} style={{ listStyle: 'none' }}>
            <CollectionCard collection={col} onOpen={onOpen} c={c} />
          </li>
        ))}
      </ul>
      {hasMore && (
        <InfiniteScrollSentinel active={hasMore && !loadingMore} onReach={() => onLoadMore?.()} />
      )}
      {loadingMore && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }} data-testid="grid-loading-more" role="status">
          <Loader size="sm" />
        </div>
      )}
      {/* End of the list: there is no next cursor and nothing is in flight. */}
      {endLabel != null && !hasMore && !loadingMore && (
        <div
          style={{ display: 'flex', justifyContent: 'center', padding: 12, fontSize: 12, color: 'var(--civitai-color-text-dimmed)' }}
          data-testid="grid-end"
        >
          {endLabel}
        </div>
      )}
    </CoverObserverContext.Provider>
  );
}

/** An observed 1px marker at the tail of the grid that requests the next page. */
function InfiniteScrollSentinel({ active, onReach }: { active: boolean; onReach: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onReachRef = useRef(onReach);
  onReachRef.current = onReach;

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onReachRef.current();
      },
      { rootMargin: SENTINEL_MARGIN },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [active]);

  return <div ref={ref} data-testid="grid-sentinel" aria-hidden="true" style={{ height: 1 }} />;
}

export function CollectionCard({
  collection,
  onOpen,
  c,
}: {
  collection: CollectionSummary;
  onOpen: (collection: CollectionSummary) => void;
  c: Palette;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(collection)}
      style={cardBtn}
      data-testid="collection-card"
      // 🔴 AN EMPTY COLLECTION IS NOT PLAYABLE, AND THIS IS A PLAYER. Measured
      // live: "Bookmarked Articles · 0 items" rendered an ordinary play
      // affordance, so the one thing the app exists to do silently does nothing.
      // `disabled` rather than hidden: the collection is really there and the
      // viewer put it there, so removing it from their own list would be a
      // second lie. The label says WHY instead of promising a play.
      disabled={collection.itemCount === 0}
      data-empty={collection.itemCount === 0 ? 'true' : undefined}
      aria-label={
        collection.itemCount === 0
          ? `${collection.name} — nothing to play yet`
          : `Play ${collection.name} — ${collection.itemCount} items`
      }
    >
      <div style={coverWrap}>
        <CoverImage src={collection.coverImageUrl} c={c} nsfwLevel={collection.coverNsfwLevel} />
        {!collection.isPublic && (
          <span style={badgeSlot('left')}>
            <Badge size="sm" variant="filled" color="warning" data-testid="private-badge">
              Private
            </Badge>
          </span>
        )}
        {collection.followed && (
          <span style={badgeSlot('right')}>
            <Badge size="sm" variant="filled" data-testid="followed-badge" aria-label="Followed">
              ★
            </Badge>
          </span>
        )}
      </div>
      <div style={cardBody}>
        <span style={cardTitle}>{collection.name}</span>
        <span style={cardMeta}>
          {collection.curator.username ? `by ${collection.curator.username}` : 'by unknown'} ·{' '}
          {collection.itemCount} {collection.itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>
    </button>
  );
}

export interface PopularRailProps {
  entries: Array<{ collection: CollectionSummary; count: number }>;
  onOpen: (collection: CollectionSummary) => void;
  c: Palette;
}

export function PopularRail({ entries, onOpen, c }: PopularRailProps) {
  const register = useCoverObserver();
  // 🔴 THE RAIL FILTERS ITSELF rather than trusting its caller. The heading makes
  // a claim ("Popular right now") that only the data can honour, so the component
  // that renders the claim is the one that checks it — a caller cannot forget.
  // See `popularRailEntries` for the two thresholds and why one is not enough.
  const shown = popularRailEntries(entries);
  if (shown.length === 0) return null;
  return (
    <CoverObserverContext.Provider value={register}>
      <section aria-label="Popular collections" data-testid="popular-rail" style={{ display: 'grid', gap: 8 }}>
        <h2 style={railHeading}>🔥 Popular right now</h2>
        <div style={railScroller}>
          {shown.map(({ collection, count }) => (
            <button
              key={collection.id}
              type="button"
              onClick={() => onOpen(collection)}
              style={railCard}
              data-testid="popular-card"
              aria-label={`Play ${collection.name} — played ${count} times`}
            >
              <div style={railCover}>
                <CoverImage src={collection.coverImageUrl} c={c} nsfwLevel={collection.coverNsfwLevel} />
              </div>
              <span style={railTitle}>{collection.name}</span>
              <span style={cardMeta}>
                <Badge size="sm" variant="light">
                  {count} {count === 1 ? 'play' : 'plays'}
                </Badge>
              </span>
            </button>
          ))}
        </div>
      </section>
    </CoverObserverContext.Provider>
  );
}

export interface RecentRailProps {
  entries: RecentEntry[];
  onOpen: (entry: RecentEntry) => void;
  c: Palette;
}

/** "Continue watching" rail — recently-played collections that reopen at their
 * saved mode + position (Feature #7). */
export function RecentRail({ entries, onOpen, c }: RecentRailProps) {
  const register = useCoverObserver();
  if (entries.length === 0) return null;
  return (
    <CoverObserverContext.Provider value={register}>
      <section aria-label="Continue watching" data-testid="recent-rail" style={{ display: 'grid', gap: 8 }}>
        <h2 style={railHeading}>⏳ Continue watching</h2>
        <div style={railScroller}>
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onOpen(entry)}
              style={railCard}
              data-testid="recent-card"
              data-collection-id={entry.id}
              aria-label={`Resume ${entry.name}`}
            >
              <div style={railCover}>
                <CoverImage src={entry.coverImageUrl} c={c} nsfwLevel={entry.coverNsfwLevel} />
              </div>
              <span style={railTitle}>{entry.name}</span>
              <span style={cardMeta}>
                <Badge size="sm" variant="light">
                  Resume
                </Badge>
              </span>
            </button>
          ))}
        </div>
      </section>
    </CoverObserverContext.Provider>
  );
}

// ---- styles (pack-token-driven so the grid matches the component pack) ----
const centerNote: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  justifyContent: 'center',
};

function gridStyle(isMobile: boolean): CSSProperties {
  return {
    display: 'grid',
    gap: 12,
    padding: 0,
    margin: 0,
    gridTemplateColumns: isMobile
      ? 'repeat(2, minmax(0, 1fr))'
      : 'repeat(auto-fill, minmax(190px, 1fr))',
  };
}

const cardBtn: CSSProperties = {
  display: 'grid',
  gap: 8,
  width: '100%',
  padding: 0,
  border: '1px solid var(--civitai-color-border)',
  borderRadius: 'var(--civitai-radius)',
  overflow: 'hidden',
  background: 'var(--civitai-color-surface)',
  color: 'var(--civitai-color-text)',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'var(--civitai-font)',
};

const coverWrap: CSSProperties = {
  position: 'relative',
  aspectRatio: '1 / 1',
  background: 'var(--civitai-color-surface-2)',
  overflow: 'hidden',
};

const coverImg: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };
const coverBadgeWrap: CSSProperties = { position: 'relative', width: '100%', height: '100%' };
const coverBadgeSlot: CSSProperties = { position: 'absolute', top: 6, left: 6, zIndex: 2, pointerEvents: 'none' };

function coverPlaceholder(c: Palette): CSSProperties {
  return {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: c.muted,
    fontSize: 28,
  };
}

function badgeSlot(side: 'left' | 'right'): CSSProperties {
  return { position: 'absolute', top: 6, [side]: 6 } as CSSProperties;
}

const cardBody: CSSProperties = { display: 'grid', gap: 2, padding: '0 10px 10px' };
const cardTitle: CSSProperties = {
  fontWeight: 700,
  fontSize: 14,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const cardMeta: CSSProperties = { fontSize: 12, color: 'var(--civitai-color-text-dimmed)' };

const railHeading: CSSProperties = { fontSize: 15, margin: 0 };
const railScroller: CSSProperties = {
  display: 'flex',
  gap: 10,
  overflowX: 'auto',
  paddingBottom: 4,
  WebkitOverflowScrolling: 'touch',
};
const railCard: CSSProperties = {
  flex: '0 0 auto',
  width: 140,
  display: 'grid',
  gap: 4,
  padding: 8,
  border: '1px solid var(--civitai-color-border)',
  borderRadius: 'var(--civitai-radius)',
  background: 'var(--civitai-color-surface)',
  color: 'var(--civitai-color-text)',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'var(--civitai-font)',
};
const railCover: CSSProperties = {
  aspectRatio: '1 / 1',
  borderRadius: 8,
  overflow: 'hidden',
  background: 'var(--civitai-color-surface-2)',
};
const railTitle: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
