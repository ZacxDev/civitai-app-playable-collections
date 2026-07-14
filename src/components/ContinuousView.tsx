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
    items,
    muted,
    scrollSpeed,
    reducedMotion,
    paused,
    autoplayCap,
    c,
    onTapItem,
    onTogglePause,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
    initialOffset = 0,
    onOffsetChange,
  } = props;

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
}: {
  item: MediaItem;
  clone: boolean;
  muted: boolean;
  play: boolean;
  c: Palette;
  onTap: (item: MediaItem) => void;
  registerTile: (el: HTMLElement | null, mediaId: number) => void;
  registerLazy: (img: HTMLImageElement | null) => void;
}) {
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
      style={tileStyle(c)}
    >
      {item.type === 'video' ? (
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
            style={mediaEl}
            data-testid={clone ? undefined : 'continuous-video'}
          />
        ) : (
          <img src={posterFor(item)} alt="" style={mediaEl} data-testid={clone ? undefined : 'continuous-poster'} loading="lazy" />
        )
      ) : (
        // Lazy image: data-src until the shared observer swaps it in near view.
        <img
          ref={clone ? undefined : registerLazy}
          data-src={clone ? undefined : item.url}
          src={clone ? item.url : undefined}
          alt=""
          style={mediaEl}
          loading="lazy"
          data-testid={clone ? undefined : 'continuous-image'}
        />
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

function tileStyle(c: Palette): CSSProperties {
  return {
    display: 'block',
    padding: 0,
    border: '1px solid ' + c.border,
    borderRadius: 10,
    overflow: 'hidden',
    background: c.card,
    cursor: 'pointer',
    // horizontal tiles are fixed-ish width; vertical tiles fill their column
    width: undefined,
    flex: '0 0 auto',
  };
}
const mediaEl: CSSProperties = { display: 'block', width: '100%', maxWidth: 260, height: 'auto', objectFit: 'cover' };
