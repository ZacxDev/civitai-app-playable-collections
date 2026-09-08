// The full-page media player: stage + transport controls.
// Mobile: swipe left/right + tap; Desktop: arrow keys + click zones. Auto-
// advances images (secondsPerImage) and loops videos (videoLoopCount) via
// usePlayer().
//
// 🔴 THIS COMPONENT NO LONGER OWNS TIPPING OR FOLLOWING, AND MUST NOT AGAIN (T5).
// It used to draw an `overlay-chrome` right rail carrying FOUR presses —
// `tip-creator`, `tip-curator`, `tip-split`, `follow-toggle` — and to render the
// tip pickers itself. Operator feedback round 4: one tip affordance, and the
// same tip + follow controls in Slideshow, Ticker AND Wall. A Player exists on
// only ONE of those three surfaces (plus the lightbox), so anything it owns is
// by construction absent from the other two. `CollectionViewer` owns both
// controls and the picker now, in a chrome row that renders on every surface.
//
// What Player keeps of that flow is the two things only it can know: WHICH media
// is on screen (`onCurrentItemChange`, which is what the picker snapshots as
// "the creator" at press time) and whether its own transport is running
// (`pickerOpen`, which pauses it so the media cannot move under an open picker).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Button, Loader, Slider } from '@civitai/blocks-react/ui';

import type { MediaItem } from '../types.js';
import { SECONDS_PER_IMAGE, VIDEO_LOOP_COUNT, type PlayerSettings } from '../settings.js';
import type { Palette } from '../theme.js';
import { usePlayer } from '../player/usePlayer.js';
import { filterToCeiling } from '../lib/maturity.js';
import { useViewerCeiling } from '../lib/viewer-maturity.js';
import { iconBtn } from './styles.js';
import { MaturityBadge } from './Maturity.js';

const SWIPE_THRESHOLD = 48;
/**
 * Fetch the next detail page when the viewer advances to within this many items
 * of the end of what's loaded — so a big collection streams in progressively
 * (feedback #2) instead of loading every page before the player renders.
 */
const LOAD_AHEAD = 5;

export interface PlayerProps {
  items: MediaItem[];
  settings: PlayerSettings;
  /** Persist + apply the seconds-per-image pref (device-local). */
  onSecondsPerImageChange: (value: number) => void;
  /** Persist + apply the video-loop-count pref (device-local). */
  onVideoLoopCountChange: (value: number) => void;
  /** Global audio mute (starts muted; user opts into audio). Default true. */
  muted?: boolean;
  /** Start on this item index (RESTORE / open the lightbox on a tapped tile). */
  initialItemIndex?: number;
  /** Reports the current playback position (order index) for persistence. */
  onPositionChange?: (position: number) => void;
  /**
   * Reports WHICH media is on screen, so the owner's tip picker can snapshot its
   * creator at press time.
   *
   * 🔴 THE OWNER MUST NOT DERIVE THIS FROM `items[initialItemIndex]`. The player
   * advances on its own timer and on its own controls; an owner that computed
   * the current item from what it passed IN would name the item the viewer
   * STARTED on, which is exactly the recipient-drift defect inverted.
   */
  onCurrentItemChange?: (item: MediaItem | null) => void;
  /** Show the in-player ⚙ settings control (sec/loop sliders). Default true; the
   * embedding viewer hides it in classic mode because its toolbar owns them. */
  showSettingsControl?: boolean;
  /**
   * The owner's tip picker is open.
   *
   * 🔴 PAUSES PLAYBACK, AND SWALLOWS EVERY PLAYER SHORTCUT. Both halves matter.
   * The pause is what stops the media moving under a viewer who is reading the
   * preview (defence in depth — the picker's press-time snapshot is what makes
   * the MONEY correct either way). The shortcut gate is what stops this
   * component's window-level Escape handler exiting the collection out from
   * under an open modal, and what stops the arrow keys advancing past the item
   * whose creator the open picker names.
   */
  pickerOpen?: boolean;
  /** Ambient "cast" mode (#8): chrome hidden, passive auto-advance (TV/2nd screen). */
  cast?: boolean;
  /** OS reduced-motion preference — pauses cast auto-advance when set. */
  reducedMotion?: boolean;
  isMobile: boolean;
  c: Palette;
  onExit: () => void;
  /** Progressive load: another detail page exists to fetch. */
  hasMore?: boolean;
  /** Progressive load: a next-page fetch is in flight. */
  loadingMore?: boolean;
  /** Progressive load: fetch + append the next page of items. */
  onLoadMore?: () => void;
}

export function Player(props: PlayerProps) {
  const {
    items,
    settings,
    onSecondsPerImageChange,
    onVideoLoopCountChange,
    muted = true,
    initialItemIndex,
    onPositionChange,
    onCurrentItemChange,
    showSettingsControl = true,
    pickerOpen = false,
    cast = false,
    reducedMotion = false,
    isMobile,
    c,
    onExit,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
  } = props;

  // 🔴 THE CEILING IS APPLIED HERE, NOT ONLY IN THE CALLER. `CollectionViewer`
  // already filters the list it passes down (it has to — the lightbox resolves an
  // index into it), so this is normally a no-op; it exists so a Player mounted by
  // any future call site cannot render over-ceiling media because that caller
  // forgot. Filtering is idempotent, so applying it twice costs one pass and
  // changes nothing. Everything below — position, `progressLabel`, the scrubber
  // max, `initialItemIndex`, the load-ahead — indexes THIS list, so the counts the
  // viewer sees and the counts the player seeks over cannot disagree.
  const ceiling = useViewerCeiling();
  const visibleItems = useMemo(() => filterToCeiling(items, ceiling), [items, ceiling]);

  const player = usePlayer({
    items: visibleItems,
    secondsPerImage: settings.secondsPerImage,
    videoLoopCount: settings.videoLoopCount,
    initialPosition: initialItemIndex,
  });

  // Report the playback position out so the viewer can persist it (restore).
  const reportPos = onPositionChange;
  const playerPosition = player.state.position;
  useEffect(() => {
    reportPos?.(playerPosition);
  }, [playerPosition, reportPos]);

  // Progressive detail load (feedback #2): when the viewer reaches within
  // LOAD_AHEAD of the end of what's loaded, pull the next page. Opening a big
  // collection therefore fires ONE fetch (page 1), not one per page up front.
  const playPosition = player.state.position;
  const loadedCount = player.state.order.length;
  useEffect(() => {
    if (!hasMore || loadingMore || !onLoadMore) return;
    if (loadedCount - 1 - playPosition <= LOAD_AHEAD) onLoadMore();
  }, [playPosition, loadedCount, hasMore, loadingMore, onLoadMore]);

  const { current } = player;
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const touchStartX = useRef<number | null>(null);

  const [chromeVisible, setChromeVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // In cast mode all overlay chrome is hidden (passive full-bleed playback).
  const chromeShown = chromeVisible && !cast;

  // Cast auto-advance: force playback on entering cast (unless reduced-motion,
  // which pauses it — respecting the OS preference like the continuous modes).
  useEffect(() => {
    if (!cast) return;
    if (reducedMotion) player.pause();
    else player.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast, reducedMotion]);

  // ---- report the media on screen up, for the owner's tip picker ----
  // 🔴 THIS IS THE ONLY THING PLAYER STILL CONTRIBUTES TO THE MONEY PATH, and it
  // reports the LIVE item deliberately. The picker's job is to FREEZE it at press
  // time; freezing it here as well would hide a drift bug rather than prevent one.
  //
  // 🔴 `useLayoutEffect`, NOT `useEffect`, AND THAT IS A MONEY BUG THIS ARC
  // ALREADY SHIPPED ONCE — caught by CI, not by the local suite. A PASSIVE effect
  // is flushed on the scheduler's own timetable, so between the commit that mounts
  // (or advances) this surface and the commit that delivers the report, the owner's
  // `currentItem` is STALE — `null` on mount. The tip control is live in that
  // window and `tipPossible` is still true, because the CURATOR side does not
  // depend on the media. So a press landing there opens a picker with the creator
  // side silently missing: it looks exactly like the self-tip collapse, and it is
  // not one. A layout effect is flushed synchronously inside the same commit, so
  // no press and no paint can observe the gap. The window is real in both
  // directions — mount, and a mode switch that replaces one surface with another.
  const onCurrentItemChangeRef = useRef(onCurrentItemChange);
  onCurrentItemChangeRef.current = onCurrentItemChange;
  useLayoutEffect(() => {
    onCurrentItemChangeRef.current?.(current ?? null);
  }, [current]);

  // ---- pause playback while the owner's picker is open (defence in depth) ----
  // The picker's press-time snapshot is what makes the money correct; this keeps
  // the STAGE from moving under a viewer who is reading a preview, which is the
  // behaviour they would expect anyway. Playback resumes only if it was running
  // when the picker opened, so this never starts a paused player.
  const resumeAfterPickerRef = useRef(false);
  const playerRef = useRef(player);
  playerRef.current = player;
  useEffect(() => {
    if (pickerOpen) {
      resumeAfterPickerRef.current = playerRef.current.playing;
      playerRef.current.pause();
    } else if (resumeAfterPickerRef.current) {
      resumeAfterPickerRef.current = false;
      playerRef.current.play();
    }
  }, [pickerOpen]);

  // ---- keyboard (all viewports; the platform routes real key events to the
  // focused iframe, and arrow keys are the desktop-primary control) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore the global player shortcuts while a form control is focused —
      // otherwise arrow keys on the focused scrubber (range input) would BOTH
      // move the scrubber AND advance the player (double-fire). Let the control
      // handle its own keys.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      // Cast mode is passive (TV / second-screen) — swallow all shortcuts.
      if (cast) return;
      // 🔴 THE OWNER'S PICKER IS OPEN: NOTHING HERE RUNS. This handler is on
      // `window`, above the modal's own `document` handler, so without this gate
      // Escape would reach `onExit()` and tear the whole collection down from
      // under an open money dialog — and the arrow keys would advance past the
      // very item whose creator that dialog names. Closing the picker is the
      // OWNER's decision (it is the only party that knows whether a leg is on
      // the wire), so this branch swallows and returns rather than closing.
      if (pickerOpen) return;
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          player.next();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          player.prev();
          break;
        case ' ':
        case 'k':
          e.preventDefault();
          player.toggle();
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'Escape':
          onExit();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.next, player.prev, player.toggle, pickerOpen, onExit, cast]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      // jsdom / older browsers: guard the call.
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  // ---- touch/swipe (mobile) ----
  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start == null) return;
    const end = e.changedTouches[0]?.clientX ?? start;
    const dx = end - start;
    if (Math.abs(dx) < SWIPE_THRESHOLD) {
      // A tap toggles the chrome on mobile.
      setChromeVisible((v) => !v);
      return;
    }
    if (dx < 0) player.next();
    else player.prev();
  };

  if (visibleItems.length === 0) {
    return (
      <div style={emptyStage(c)} data-testid="player-empty">
        <p>This collection has no playable media.</p>
        <Button variant="outline" onClick={onExit} data-testid="player-exit">
          ← Back to collections
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      style={stageStyle(c)}
      data-testid="player"
      data-layout={isMobile ? 'mobile' : 'desktop'}
      data-media-type={current?.type ?? 'none'}
      data-cast={cast ? 'on' : 'off'}
    >
      {/* ---- media ---- */}
      <div
        style={mediaWrap}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        data-testid="media-stage"
      >
        {current?.type === 'video' ? (
          <video
            ref={videoRef}
            key={current.mediaId}
            src={current.url}
            style={mediaEl}
            autoPlay={player.playing}
            muted={muted}
            playsInline
            data-testid="media-video"
            onEnded={() => {
              const result = player.onVideoEnded();
              if (result === 'replay' && videoRef.current) {
                videoRef.current.currentTime = 0;
                // play() can reject (autoplay policy) or be unimplemented (jsdom).
                try {
                  const p = videoRef.current.play?.();
                  if (p && typeof p.catch === 'function') void p.catch(() => {});
                } catch {
                  /* ignore */
                }
              }
            }}
          />
        ) : current ? (
          <img
            src={current.url}
            alt=""
            style={mediaEl}
            data-testid="media-image"
          />
        ) : null}

        {/* Rating badge (top-centre of the stage). Everything on screen is within
            the viewer's ceiling — the badge labels it, it does not hide it. */}
        {current && (
          <span style={maturityBadgeSlot}>
            <MaturityBadge nsfwLevel={current.nsfwLevel} />
          </span>
        )}

        {/* preload next */}
        {player.upcoming?.type === 'image' && (
          <img src={player.upcoming.url} alt="" style={{ display: 'none' }} aria-hidden="true" />
        )}

        {/* desktop click zones (behind chrome; disabled in passive cast mode) */}
        {!isMobile && !cast && (
          <>
            <button
              type="button"
              aria-label="Previous"
              onClick={player.prev}
              style={clickZone('left')}
              data-testid="clickzone-prev"
            />
            <button
              type="button"
              aria-label="Play or pause"
              onClick={player.toggle}
              style={clickZone('center')}
              data-testid="clickzone-toggle"
            />
            <button
              type="button"
              aria-label="Next"
              onClick={player.next}
              style={clickZone('right')}
              data-testid="clickzone-next"
            />
          </>
        )}
      </div>

      {/* ---- top overlay: title + exit ---- */}
      {/* The THIRD "⚡ <balance>" readout lived here, sharing the `buzz-balance`
          testid with the App header's. Removed 2026-09-05 alongside the other two
          — this one is the most intrusive of the three, since it sat over the
          media on the default `classic` playback surface. The `buzzBalance` prop
          that survived it went with the tip pickers in T5: this component no
          longer validates, previews or sends a tip, so it has no use for a
          balance. `CollectionViewer` holds it now. */}
      {/* 🔴 THE TOP OVERLAY IS GONE (0.2.14) AND MUST NOT COME BACK HERE.
          It carried a back button plus the collection name and curator, in
          hardcoded white-on-media text — DUPLICATING the themed toolbar that
          CollectionViewer already renders directly above this component in
          `classic` mode. Operator feedback: "the title, curator and back button
          appear twice … remove the overlay."

          🔴 It was NOT simply deleted, because this component is ALSO the
          lightbox, where it is mounted inside an `aria-modal` dialog that COVERS
          that toolbar — there the overlay was the only back affordance and the
          only title. Deleting it outright would have stranded the modal. The
          replacement is a THEMED header rendered by the lightbox itself
          (`CollectionViewer.tsx`, search `lightbox-header`), which reuses the
          toolbar's own `toolbarStyle`/`titleStyle`/`subStyle` so the two cannot
          drift apart.

          So: Player no longer renders ANY title, curator or exit chrome. Whoever
          mounts it owns that. If you are adding a Player surface, give it a
          header — do not restore this block. */}

      {/* ---- bottom transport ---- */}
      {chromeShown && (
        <div style={bottomBar(c)}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
            <button type="button" onClick={player.prev} style={iconBtn(c)} aria-label="Previous" data-testid="ctrl-prev">
              ⏮
            </button>
            <button
              type="button"
              onClick={player.toggle}
              style={iconBtn(c, player.playing)}
              aria-label={player.playing ? 'Pause' : 'Play'}
              aria-pressed={player.playing}
              data-testid="ctrl-play"
            >
              {player.playing ? '⏸' : '▶'}
            </button>
            <button type="button" onClick={player.next} style={iconBtn(c)} aria-label="Next" data-testid="ctrl-next">
              ⏭
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              style={iconBtn(c, isFullscreen)}
              aria-label="Fullscreen"
              aria-pressed={isFullscreen}
              data-testid="ctrl-fullscreen"
            >
              ⛶
            </button>
            {showSettingsControl && (
              <button
                type="button"
                onClick={() => setShowSettings((v) => !v)}
                style={iconBtn(c, showSettings)}
                aria-label="Playback settings"
                aria-pressed={showSettings}
                aria-expanded={showSettings}
                data-testid="ctrl-settings"
              >
                ⚙
              </button>
            )}
          </div>

          {showSettingsControl && showSettings && (
            <SettingsPanel
              c={c}
              secondsPerImage={settings.secondsPerImage}
              videoLoopCount={settings.videoLoopCount}
              onSecondsPerImageChange={onSecondsPerImageChange}
              onVideoLoopCountChange={onVideoLoopCountChange}
            />
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Slider
              min={0}
              max={Math.max(0, player.state.order.length - 1)}
              value={player.state.position}
              onChange={player.seekToPosition}
              style={{ flex: 1 }}
              aria-label="Seek"
              data-testid="scrubber"
            />
            {loadingMore && (
              <span data-testid="player-loading-more" title="Loading more">
                <Loader size="sm" color="#fff" />
              </span>
            )}
            <span style={progressText(c)} data-testid="progress-label">
              {player.progressLabel}
            </span>
          </div>
        </div>
      )}

    </div>
  );
}

/**
 * In-app playback settings (two sliders). Replaces the host settings form —
 * the page host doesn't deliver viewer settings, so these device-local prefs are
 * controlled here and persisted to localStorage by the parent's setters.
 */
function SettingsPanel({
  c,
  secondsPerImage,
  videoLoopCount,
  onSecondsPerImageChange,
  onVideoLoopCountChange,
}: {
  c: Palette;
  secondsPerImage: number;
  videoLoopCount: number;
  onSecondsPerImageChange: (value: number) => void;
  onVideoLoopCountChange: (value: number) => void;
}) {
  return (
    <div style={settingsPanel(c)} data-testid="settings-panel" role="group" aria-label="Playback settings">
      <label style={settingsRow}>
        <span style={settingsLabel}>Seconds per image</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Slider
            min={SECONDS_PER_IMAGE.min}
            max={SECONDS_PER_IMAGE.max}
            step={1}
            value={secondsPerImage}
            onChange={onSecondsPerImageChange}
            aria-label="Seconds per image"
            data-testid="set-seconds-per-image"
            style={{ flex: 1 }}
          />
          <span style={settingsValue} data-testid="seconds-per-image-value">
            {secondsPerImage}s
          </span>
        </span>
      </label>
      <label style={settingsRow}>
        <span style={settingsLabel}>Video loop count</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Slider
            min={VIDEO_LOOP_COUNT.min}
            max={VIDEO_LOOP_COUNT.max}
            step={1}
            value={videoLoopCount}
            onChange={onVideoLoopCountChange}
            aria-label="Video loop count"
            data-testid="set-video-loop-count"
            style={{ flex: 1 }}
          />
          <span style={settingsValue} data-testid="video-loop-count-value">
            {videoLoopCount}×
          </span>
        </span>
      </label>
    </div>
  );
}

// ---- styles ----
function stageStyle(c: Palette): CSSProperties {
  return {
    position: 'relative',
    width: '100%',
    height: '100dvh',
    minHeight: 480,
    background: c.stageBg,
    overflow: 'hidden',
    fontFamily: 'inherit',
  };
}
const mediaWrap: CSSProperties = { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const maturityBadgeSlot: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 6,
  pointerEvents: 'none',
};
const mediaEl: CSSProperties = { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' };

function clickZone(which: 'left' | 'center' | 'right'): CSSProperties {
  const base: CSSProperties = {
    position: 'absolute',
    top: 60,
    bottom: 120,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
  };
  if (which === 'left') return { ...base, left: 0, width: '30%' };
  if (which === 'right') return { ...base, right: 0, width: '30%' };
  return { ...base, left: '30%', width: '40%' };
}


function bottomBar(c: Palette): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    display: 'grid',
    gap: 8,
    padding: 12,
    paddingBottom: 'max(12px, env(safe-area-inset-bottom, 12px))',
    background: `linear-gradient(transparent, ${c.overlay})`,
    zIndex: 5,
  };
}
function progressText(c: Palette): CSSProperties {
  return { color: '#fff', fontSize: 12, minWidth: 54, textAlign: 'right', textShadow: '0 1px 2px ' + c.stageBg };
}

function settingsPanel(c: Palette): CSSProperties {
  return {
    display: 'grid',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    background: c.card,
    border: '1px solid ' + c.border,
    color: c.fg,
  };
}
const settingsRow: CSSProperties = { display: 'grid', gap: 4 };
const settingsLabel: CSSProperties = { fontSize: 13, fontWeight: 600 };
const settingsValue: CSSProperties = { fontSize: 13, minWidth: 34, textAlign: 'right' };

function emptyStage(c: Palette): CSSProperties {
  return {
    width: '100%',
    minHeight: '100dvh',
    background: c.bg,
    color: c.fg,
    display: 'grid',
    placeContent: 'center',
    gap: 12,
    padding: 24,
    textAlign: 'center',
  };
}
