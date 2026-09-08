// Continuous view modes: an ambient AUTO-SCROLL surface in two orientations.
//   - continuous-horizontal → a single row that drifts sideways (marquee/ticker).
//   - continuous-vertical   → a responsive column wall (3 → 2 → 1 cols) drifting up.
//
// The scroll ARITHMETIC is the pure `advanceOffset`/`shouldAutoScroll` seam in
// ../modes/scroll-engine.ts — this component only owns the rAF loop, the DOM,
// lazy media mounting, the concurrency-capped video autoplay, page-ahead, and
// pause/scrub. 🔴 `prefers-reduced-motion` disables the drift entirely (the mode
// becomes a plain user-scrollable surface). Tapping a tile bubbles up to open the
// classic lightbox (Feature 3); the surface itself is browse-only.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type { MediaItem } from '../types.js';
import type { Palette } from '../theme.js';
import { assignColumns, columnCount } from '../modes/columns.js';
import { selectPlayable } from '../modes/autoplay.js';
import { advanceOffset, clampDt, shouldAutoScroll } from '../modes/scroll-engine.js';
import { filterToCeiling } from '../lib/maturity.js';
import { useViewerCeiling } from '../lib/viewer-maturity.js';
import { MaturityBadge } from './Maturity.js';

/** Fetch more when the tail sentinel comes near — continuous modes burn items fast. */
const SENTINEL_MARGIN = '400px';

export interface ContinuousViewProps {
  orientation: 'horizontal' | 'vertical';
  items: MediaItem[];
  muted: boolean;
  /** Auto-scroll speed in px/s. */
  scrollSpeed: number;
  /** 🔴 When true, auto-scroll is disabled and the surface is user-scrollable. */
  reducedMotion: boolean;
  paused: boolean;
  /** Max concurrently-autoplaying videos (the perf guard). */
  autoplayCap: number;
  c: Palette;
  /** Tap a tile → open it in the classic lightbox. */
  onTapItem: (item: MediaItem) => void;
  /**
   * Reports WHICH media this surface currently stands for, so the owner's tip
   * picker has a creator to name here too (T5 criterion 2 — Ticker and Wall
   * could not tip a creator at all before, because neither had a "current item").
   *
   * 🔴 IT IS THE FIRST IN-VIEW TILE IN DISPLAY ORDER, AND IT FALLS BACK TO THE
   * FIRST ITEM. Both halves are load-bearing. In-view comes from the SAME
   * `useInViewIds` observer that already decides which videos may autoplay, so
   * the item named here is one the viewer can actually see. The fallback covers
   * every environment with no working `IntersectionObserver` (jsdom, and any
   * browser before the observer's first callback): without it `inViewIds` is
   * empty, the creator side resolves to `null`, and the picker would silently
   * offer a curator-only tip on a surface where a creator tip is exactly what
   * the viewer asked for — a collapse that LOOKS like the self-tip collapse and
   * is not one.
   */
  onCurrentItemChange?: (item: MediaItem | null) => void;
  /** Press/hold or the pause control toggles this. */
  onTogglePause: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Restore anchor (scroll offset px) + persistence callback. */
  initialOffset?: number;
  onOffsetChange?: (offset: number) => void;
}

export function ContinuousView(props: ContinuousViewProps) {
  const {
    orientation,
    items: allItems,
    muted,
    scrollSpeed,
    reducedMotion,
    paused,
    autoplayCap,
    c,
    onTapItem,
    onCurrentItemChange,
    onTogglePause,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
    initialOffset = 0,
    onOffsetChange,
  } = props;

  // 🔴 THE CEILING IS APPLIED HERE, NOT ONLY IN THE CALLER — same argument as
  // Player's: `CollectionViewer` already filters, so this is normally a no-op,
  // but it means no call site can mount this surface over unfiltered items. An
  // over-ceiling tile is ABSENT from the wall/ticker, not blurred: there is no
  // tile to tap, so there is nothing to reveal. Everything downstream (columns,
  // the autoplay cap, the clone copy) reads `items`.
  const ceiling = useViewerCeiling();
  const items = useMemo(() => filterToCeiling(allItems, ceiling), [allItems, ceiling]);

  const autoScroll = shouldAutoScroll(reducedMotion, paused);
  const horizontal = orientation === 'horizontal';

  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // ---- measure the viewport width (drives the responsive column count) ----
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || el.offsetWidth || 0);
    measure();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
  }, []);

  const cols = horizontal ? 1 : columnCount(width);
  const columns = useMemo(() => (horizontal ? [items] : assignColumns(items, cols)), [items, cols, horizontal]);

  // ---- which videos may autoplay right now (in-view ∩ cap) ----
  const { inViewIds, registerTile } = useInViewIds();
  const playable = useMemo(() => {
    // display-order video ids that are currently in view
    const ordered = items.filter((it) => it.type === 'video' && inViewIds.has(it.mediaId)).map((it) => it.mediaId);
    return selectPlayable(ordered, autoplayCap);
  }, [items, inViewIds, autoplayCap]);

  // ---- which media this surface stands for, for the owner's tip picker ----
  // See `onCurrentItemChange`'s doc for why the fallback is not optional.
  const currentItem = useMemo(
    () => items.find((it) => inViewIds.has(it.mediaId)) ?? items[0] ?? null,
    [items, inViewIds],
  );
  // 🔴 `useLayoutEffect`, for the same reason as Player's twin of this block —
  // read that one. A PASSIVE effect leaves the owner's `currentItem` stale for the
  // window between this surface committing and the scheduler flushing, and the tip
  // control is live in that window. On this surface the window opens on every
  // mode switch INTO it, which is an ordinary two-click action.
  const onCurrentItemChangeRef = useRef(onCurrentItemChange);
  onCurrentItemChangeRef.current = onCurrentItemChange;
  useLayoutEffect(() => {
    onCurrentItemChangeRef.current?.(currentItem);
  }, [currentItem]);

  // ---- lazy cover swap for images (data-src → src on intersect) ----
  const registerLazy = useLazyImages();

  // ---- rAF auto-scroll loop (pure math in scroll-engine) ----
  const offsetRef = useRef(initialOffset);
  const lastTsRef = useRef<number | null>(null);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const speedRef = useRef(scrollSpeed);
  speedRef.current = scrollSpeed;
  const onOffsetChangeRef = useRef(onOffsetChange);
  onOffsetChangeRef.current = onOffsetChange;

  const applyTransform = useCallback(
    (offset: number) => {
      const track = trackRef.current;
      if (!track) return;
      track.style.transform = horizontal ? `translateX(${-offset}px)` : `translateY(${-offset}px)`;
    },
    [horizontal],
  );

  // Apply the restored/initial offset once mounted (and whenever it's reset).
  useLayoutEffect(() => {
    offsetRef.current = initialOffset;
    applyTransform(initialOffset);
  }, [initialOffset, applyTransform]);

  useEffect(() => {
    if (!autoScroll) {
      lastTsRef.current = null;
      return;
    }
    if (typeof requestAnimationFrame !== 'function') return; // jsdom: no motion, structure still valid
    let raf = 0;
    const contentSize = () => {
      const track = trackRef.current;
      if (!track) return 0;
      // one "copy" = half the doubled track (we render two copies for the loop)
      return horizontal ? track.scrollWidth / 2 : track.scrollHeight / 2;
    };
    const tick = (ts: number) => {
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      if (last != null) {
        const dt = clampDt((ts - last) / 1000);
        const next = advanceOffset(offsetRef.current, dt, speedRef.current, contentSize());
        offsetRef.current = next;
        applyTransform(next);
        onOffsetChangeRef.current?.(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      lastTsRef.current = null;
    };
  }, [autoScroll, horizontal, applyTransform]);

  // ---- press/hold to pause (background only; tiles handle their own tap) ----
  const onPointerDownBackground = (e: React.PointerEvent) => {
    // only the surface background, not a tile button
    if ((e.target as HTMLElement).closest('[data-tile]')) return;
    if (autoScroll) onTogglePause();
  };

  const renderTiles = (clone: boolean) =>
    horizontal ? (
      <div style={rowStyle} data-copy={clone ? 'clone' : 'primary'} aria-hidden={clone || undefined}>
        {items.map((item) => (
          <Tile
            key={item.mediaId}
            item={item}
            clone={clone}
            muted={muted}
            play={playable.has(item.mediaId)}
            c={c}
            onTap={onTapItem}
            registerTile={registerTile}
            registerLazy={registerLazy}
            horizontal={horizontal}
          />
        ))}
      </div>
    ) : (
      <div style={wallStyle(cols)} data-copy={clone ? 'clone' : 'primary'} aria-hidden={clone || undefined}>
        {columns.map((colItems, ci) => (
          <div key={ci} style={colStyle} data-column={ci}>
            {colItems.map((item) => (
              <Tile
                key={item.mediaId}
                item={item}
                clone={clone}
                muted={muted}
                play={playable.has(item.mediaId)}
                c={c}
                onTap={onTapItem}
                registerTile={registerTile}
                registerLazy={registerLazy}
                horizontal={horizontal}
              />
            ))}
          </div>
        ))}
      </div>
    );

  return (
    <div
      ref={viewportRef}
      data-testid="continuous-view"
      data-orientation={orientation}
      data-autoscroll={autoScroll ? 'on' : 'off'}
      style={viewportStyle(horizontal, autoScroll, c)}
      onPointerDown={onPointerDownBackground}
    >
      <div
        ref={trackRef}
        style={trackStyle(horizontal)}
        data-testid="continuous-track"
      >
        {renderTiles(false)}
        {/* second copy makes the drift seamless (only needed while auto-scrolling) */}
        {autoScroll && renderTiles(true)}
      </div>

      {/* page-ahead sentinel — continuous modes consume items fast */}
      {hasMore && <PageAheadSentinel active={hasMore && !loadingMore} onReach={() => onLoadMore?.()} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------
function Tile({
  item,
  clone,
  muted,
  play,
  c,
  onTap,
  registerTile,
  registerLazy,
  horizontal,
}: {
  item: MediaItem;
  clone: boolean;
  muted: boolean;
  play: boolean;
  c: Palette;
  onTap: (item: MediaItem) => void;
  registerTile: (el: HTMLElement | null, mediaId: number) => void;
  registerLazy: (img: HTMLImageElement | null) => void;
  /** Ticker (row) vs wall (grid) — decides whether the tile needs its own width. */
  horizontal: boolean;
}) {
  // Every tile that reaches here is within the viewer's ceiling (the surface
  // filtered the list), so it renders at full strength with a rating badge.
  const media = mediaStyle(item);
  // The poster URL is derived by string-replacing `.mp4→.jpg` (brittle); if it
  // or a lazy cover 404s, fall back to a neutral placeholder instead of a broken
  // image icon.
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      data-tile={clone ? 'clone' : 'primary'}
      data-testid={clone ? undefined : 'continuous-tile'}
      data-media-id={clone ? undefined : item.mediaId}
      data-media-type={item.type}
      data-playing={item.type === 'video' && play ? 'true' : 'false'}
      aria-label={`Open ${item.type} by ${item.creator.username ?? 'unknown'}`}
      aria-hidden={clone || undefined}
      tabIndex={clone ? -1 : 0}
      onClick={() => !clone && onTap(item)}
      ref={clone ? undefined : (el) => registerTile(el, item.mediaId)}
      style={tileStyle(c, horizontal)}
    >
      {broken ? (
        <div style={{ ...media, ...tilePlaceholder(c) }} data-testid={clone ? undefined : 'continuous-placeholder'} aria-hidden="true">
          ▶
        </div>
      ) : item.type === 'video' ? (
        // Poster (first-frame/transcoded still) mirrors the server cover approach;
        // the video only mounts/plays when it wins an autoplay slot.
        play ? (
          <video
            src={item.url}
            poster={posterFor(item)}
            muted={muted}
            autoPlay
            loop
            playsInline
            style={media}
            data-testid={clone ? undefined : 'continuous-video'}
          />
        ) : (
          <img
            src={posterFor(item)}
            alt=""
            style={media}
            data-testid={clone ? undefined : 'continuous-poster'}
            loading="lazy"
            onError={() => !clone && setBroken(true)}
          />
        )
      ) : (
        // Lazy image: data-src until the shared observer swaps it in near view.
        <img
          ref={clone ? undefined : registerLazy}
          data-src={clone ? undefined : item.url}
          src={clone ? item.url : undefined}
          alt=""
          style={media}
          loading="lazy"
          data-testid={clone ? undefined : 'continuous-image'}
          onError={() => !clone && setBroken(true)}
        />
      )}
      {!clone && (
        <span style={tileBadgeSlot}>
          <MaturityBadge nsfwLevel={item.nsfwLevel} />
        </span>
      )}
    </button>
  );
}

/** The video's first-frame/transcoded still. Mirrors the server-side cover:
 * request a poster/thumb rather than decoding the whole clip off-screen. */
function posterFor(item: MediaItem): string {
  // The block API serves media by URL; a `.mp4` cover is the transcoded still
  // (same host convention as the grid covers). Fall back to the media URL.
  return item.url.replace(/\.(mp4|webm)(\?|$)/i, '.jpg$2');
}

// ---------------------------------------------------------------------------
// In-view tracking (shared IntersectionObserver → Set of in-view mediaIds)
// ---------------------------------------------------------------------------
function useInViewIds(): {
  inViewIds: Set<number>;
  registerTile: (el: HTMLElement | null, mediaId: number) => void;
} {
  const [inViewIds, setInViewIds] = useState<Set<number>>(() => new Set());
  const idByEl = useRef(new WeakMap<Element, number>());

  const observer = useMemo(() => {
    if (typeof IntersectionObserver === 'undefined') return null;
    return new IntersectionObserver((entries) => {
      setInViewIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const entry of entries) {
          const id = idByEl.current.get(entry.target);
          if (id == null) continue;
          if (entry.isIntersecting && !next.has(id)) {
            next.add(id);
            changed = true;
          } else if (!entry.isIntersecting && next.has(id)) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
  }, []);

  useEffect(() => () => observer?.disconnect(), [observer]);

  const registerTile = useCallback(
    (el: HTMLElement | null, mediaId: number) => {
      if (!el || !observer) return;
      idByEl.current.set(el, mediaId);
      observer.observe(el);
    },
    [observer],
  );

  return { inViewIds, registerTile };
}

// ---------------------------------------------------------------------------
// Lazy image swap (data-src → src) — same idiom as the grid's cover observer.
// ---------------------------------------------------------------------------
function useLazyImages(): (img: HTMLImageElement | null) => void {
  const observer = useMemo(() => {
    if (typeof IntersectionObserver === 'undefined') return null;
    return new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target as HTMLImageElement;
          const ds = img.getAttribute('data-src');
          if (ds) {
            img.src = ds;
            img.removeAttribute('data-src');
          }
          obs.unobserve(img);
        }
      },
      { rootMargin: '300px' },
    );
  }, []);

  useEffect(() => () => observer?.disconnect(), [observer]);

  return useCallback(
    (img: HTMLImageElement | null) => {
      if (!img) return;
      if (!observer) {
        const ds = img.getAttribute('data-src');
        if (ds) {
          img.src = ds;
          img.removeAttribute('data-src');
        }
        return;
      }
      observer.observe(img);
    },
    [observer],
  );
}

// ---------------------------------------------------------------------------
// Page-ahead sentinel
// ---------------------------------------------------------------------------
function PageAheadSentinel({ active, onReach }: { active: boolean; onReach: () => void }) {
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
  return <div ref={ref} data-testid="continuous-sentinel" aria-hidden="true" style={{ width: 1, height: 1 }} />;
}

// ---- styles ----
function viewportStyle(horizontal: boolean, autoScroll: boolean, c: Palette): CSSProperties {
  return {
    position: 'relative',
    width: '100%',
    background: c.stageBg,
    // Auto-scroll hides overflow (rAF drives it); reduced-motion/paused makes it
    // a normal user-scrollable surface.
    overflowX: horizontal ? (autoScroll ? 'hidden' : 'auto') : 'hidden',
    overflowY: horizontal ? 'hidden' : autoScroll ? 'hidden' : 'auto',
    height: horizontal ? undefined : '78dvh',
    minHeight: horizontal ? undefined : 360,
    touchAction: autoScroll ? 'none' : 'auto',
  };
}

function trackStyle(horizontal: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: horizontal ? 'row' : 'column',
    willChange: 'transform',
  };
}

const rowStyle: CSSProperties = { display: 'flex', flexDirection: 'row', gap: 10, padding: 10 };
function wallStyle(cols: number): CSSProperties {
  return { display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 10, padding: 10, width: '100%' };
}
const colStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 };

const tileBadgeSlot: CSSProperties = { position: 'absolute', top: 6, left: 6, zIndex: 2, pointerEvents: 'none' };

function tilePlaceholder(c: Palette): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
    color: c.muted,
    fontSize: 28,
    background: c.card,
  };
}

/**
 * The ticker's fixed tile width. It matches what `maxWidth: 260` used to cap the
 * media to, so tiles are the size they always were — the difference is that the
 * box now EXISTS before the media does.
 */
const TILE_W = 260;

/**
 * Widest and narrowest box we will reserve, as width÷height.
 *
 * 🔴 A CLAMP, NOT A PREFERENCE. `MediaItem.width`/`height` are whatever the API
 * says, and a junk or extreme value would otherwise reserve a box tall enough to
 * push every other tile off the screen — trading a shift for something worse.
 * `objectFit: 'cover'` means a clamped ratio still fills its box correctly; the
 * item is cropped, not distorted.
 */
const MIN_ASPECT = 1 / 3;
const MAX_ASPECT = 3;
/** Reserved when the item's own dimensions are unusable. Square is neutral. */
const FALLBACK_ASPECT = 1;

/**
 * The aspect ratio to reserve for one item, as a CSS `aspect-ratio` number.
 *
 * 🔴 THIS IS THE WHOLE FIX. Before it, a tile's size came only from its media:
 * `mediaEl` was `width: '100%'` inside a `flex: '0 0 auto'` parent with no width,
 * so the percentage resolved against an INDEFINITE width — i.e. 0 — until the
 * image or poster loaded, at which point the tile snapped to its intrinsic size
 * and everything after it on the row jumped. `MediaItem` has carried `width` and
 * `height` all along, so the box was always computable without waiting.
 */
function aspectOf(item: Pick<MediaItem, 'width' | 'height'>): number {
  const { width, height } = item;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return FALLBACK_ASPECT;
  }
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, width / height));
}

function tileStyle(c: Palette, horizontal: boolean): CSSProperties {
  return {
    position: 'relative',
    display: 'block',
    padding: 0,
    border: '1px solid ' + c.border,
    borderRadius: 10,
    overflow: 'hidden',
    background: c.card,
    cursor: 'pointer',
    // 🔴 The ticker is a flex ROW, so a tile with no width is sized entirely by
    // its content and collapses to 0 until that content loads. A definite width
    // is what stops the row re-flowing. The wall is a GRID whose columns are
    // `minmax(0, 1fr)`, so its tiles already have a definite width from the
    // column — giving them a fixed one would break the responsive layout.
    width: horizontal ? TILE_W : undefined,
    flex: '0 0 auto',
  };
}

/**
 * Media fills its tile and RESERVES its height from the item's own ratio, so the
 * tile is its final size before the first byte arrives. `height: auto` is gone
 * deliberately: it is what made the height depend on the loaded resource.
 */
function mediaStyle(item: Pick<MediaItem, 'width' | 'height'>): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    height: 'auto',
    aspectRatio: aspectOf(item),
    objectFit: 'cover',
  };
}
