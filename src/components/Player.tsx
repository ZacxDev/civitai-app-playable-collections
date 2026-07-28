// The full-page media player: stage + overlay chrome + transport controls.
// Mobile: swipe left/right + tap; Desktop: arrow keys + click zones. Auto-
// advances images (secondsPerImage) and loops videos (videoLoopCount) via
// usePlayer(). Overlay chrome: tip creator, tip curator, follow toggle, Buzz
// balance readout. Tipped/followed state reflected optimistically.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Button, Loader, Slider } from '@civitai/blocks-react/ui';

import type { CollectionDetail, MediaItem } from '../types.js';
import { SECONDS_PER_IMAGE, VIDEO_LOOP_COUNT, type PlayerSettings } from '../settings.js';
import { mutedText, stage, token, type Palette } from '../theme.js';
import { usePlayer } from '../player/usePlayer.js';
import { iconBtn } from './styles.js';
import { TipModal, type TipTarget } from './TipModal.js';

const SWIPE_THRESHOLD = 48;
/**
 * Fetch the next detail page when the viewer advances to within this many items
 * of the end of what's loaded — so a big collection streams in progressively
 * (feedback #2) instead of loading every page before the player renders.
 */
const LOAD_AHEAD = 5;

export interface PlayerProps {
  detail: CollectionDetail;
  items: MediaItem[];
  settings: PlayerSettings;
  /** Persist + apply the seconds-per-image pref (device-local). */
  onSecondsPerImageChange: (value: number) => void;
  /** Persist + apply the video-loop-count pref (device-local). */
  onVideoLoopCountChange: (value: number) => void;
  viewerUserId: number | null;
  buzzBalance: number | null;
  /** Global audio mute (starts muted; user opts into audio). Default true. */
  muted?: boolean;
  /** Start on this item index (RESTORE / open the lightbox on a tapped tile). */
  initialItemIndex?: number;
  /** Reports the current playback position (order index) for persistence. */
  onPositionChange?: (position: number) => void;
  /** Show the in-player ⚙ settings control (sec/loop sliders). Default true; the
   * embedding viewer hides it in classic mode because its toolbar owns them. */
  showSettingsControl?: boolean;
  followed: boolean;
  followPending: boolean;
  onToggleFollow: () => void;
  /** Perform the tip. Resolves true on success (Player then marks it tipped). */
  onTip: (target: TipTarget, amount: number) => Promise<boolean>;
  tipping: boolean;
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
    detail,
    items,
    settings,
    onSecondsPerImageChange,
    onVideoLoopCountChange,
    viewerUserId,
    buzzBalance,
    muted = true,
    initialItemIndex,
    onPositionChange,
    showSettingsControl = true,
    followed,
    followPending,
    onToggleFollow,
    onTip,
    tipping,
    isMobile,
    c,
    onExit,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
  } = props;

  const player = usePlayer({
    items,
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

  const [tipTarget, setTipTarget] = useState<TipTarget | null>(null);
  const [tippedKeys, setTippedKeys] = useState<Set<string>>(new Set());
  const [chromeVisible, setChromeVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const creatorIsSelf = current != null && viewerUserId != null && current.creator.userId === viewerUserId;
  const curatorIsSelf = viewerUserId != null && detail.curator.userId === viewerUserId;
  const creatorTipped = current != null && tippedKeys.has(`Image:${current.mediaId}`);
  const curatorTipped = tippedKeys.has(`Collection:${detail.id}`);

  // ---- keyboard (all viewports; the platform routes real key events to the
  // focused iframe, and arrow keys are the desktop-primary control) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tipTarget) {
        if (e.key === 'Escape') setTipTarget(null);
        return;
      }
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
  }, [player.next, player.prev, player.toggle, tipTarget, onExit]);

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

  const openTip = (kind: 'creator' | 'curator') => {
    if (kind === 'creator') {
      if (!current || creatorIsSelf) return;
      setTipTarget({
        kind,
        toUserId: current.creator.userId,
        username: current.creator.username,
        entityType: 'Image',
        entityId: current.mediaId,
      });
    } else {
      if (curatorIsSelf) return;
      setTipTarget({
        kind,
        toUserId: detail.curator.userId,
        username: detail.curator.username,
        entityType: 'Collection',
        entityId: detail.id,
      });
    }
  };

  const confirmTip = async (amount: number) => {
    if (!tipTarget) return;
    const ok = await onTip(tipTarget, amount);
    if (ok) {
      setTippedKeys((prev) => {
        const next = new Set(prev);
        next.add(`${tipTarget.entityType}:${tipTarget.entityId}`);
        return next;
      });
      setTipTarget(null);
    }
  };

  if (items.length === 0) {
    return (
      <div style={emptyStage(c)} data-testid="player-empty">
        <p style={{ margin: 0, ...mutedText }}>This collection has no playable media.</p>
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
          <img src={current.url} alt="" style={mediaEl} data-testid="media-image" />
        ) : null}

        {/* preload next */}
        {player.upcoming?.type === 'image' && (
          <img src={player.upcoming.url} alt="" style={{ display: 'none' }} aria-hidden="true" />
        )}

        {/* desktop click zones (behind chrome) */}
        {!isMobile && (
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

      {/* ---- top overlay: title + exit + buzz ---- */}
      {chromeVisible && (
        <div style={topBar(c)}>
          <button type="button" onClick={onExit} style={iconBtn()} aria-label="Back to collections" data-testid="player-exit">
            ←
          </button>
          <div style={titleWrap}>
            <span style={titleText}>{detail.name}</span>
            <span style={subText}>
              {detail.curator.username ? `curated by ${detail.curator.username}` : 'curated collection'}
            </span>
          </div>
          <span style={buzzReadout(c)} data-testid="buzz-balance" aria-label="Your Buzz balance">
            ⚡ {buzzBalance != null ? buzzBalance.toLocaleString() : '—'}
          </span>
        </div>
      )}

      {/* ---- right overlay chrome: tip/follow ---- */}
      {chromeVisible && (
        <div style={rightRail} data-testid="overlay-chrome">
          <ChromeButton
            glyph={creatorTipped ? '✓' : '💸'}
            label={creatorTipped ? 'Tipped creator' : 'Tip creator'}
            disabled={!current || creatorIsSelf || tipping}
            active={creatorTipped}
            onClick={() => openTip('creator')}
            testid="tip-creator"
          />
          <ChromeButton
            glyph={curatorTipped ? '✓' : '🎁'}
            label={curatorTipped ? 'Tipped curator' : 'Tip curator'}
            disabled={curatorIsSelf || tipping}
            active={curatorTipped}
            onClick={() => openTip('curator')}
            testid="tip-curator"
          />
          <ChromeButton
            glyph={followed ? '★' : '☆'}
            label={followed ? 'Following' : 'Follow collection'}
            disabled={followPending}
            active={followed}
            onClick={onToggleFollow}
            testid="follow-toggle"
          />
        </div>
      )}

      {/* ---- bottom transport ---- */}
      {chromeVisible && (
        <div style={bottomBar(c)}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
            <button type="button" onClick={player.prev} style={iconBtn()} aria-label="Previous" data-testid="ctrl-prev">
              ⏮
            </button>
            <button
              type="button"
              onClick={player.toggle}
              style={iconBtn(player.playing)}
              aria-label={player.playing ? 'Pause' : 'Play'}
              aria-pressed={player.playing}
              data-testid="ctrl-play"
            >
              {player.playing ? '⏸' : '▶'}
            </button>
            <button type="button" onClick={player.next} style={iconBtn()} aria-label="Next" data-testid="ctrl-next">
              ⏭
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              style={iconBtn(isFullscreen)}
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
                style={iconBtn(showSettings)}
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
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
                <Loader size="sm" color={stage.chromeFg} />
              </span>
            )}
            <span style={progressText()} data-testid="progress-label">
              {player.progressLabel}
            </span>
          </div>
        </div>
      )}

      {tipTarget && (
        <TipModal
          target={tipTarget}
          balance={buzzBalance}
          submitting={tipping}
          onConfirm={confirmTip}
          onClose={() => setTipTarget(null)}
        />
      )}
    </div>
  );
}

function ChromeButton({
  glyph,
  label,
  disabled,
  active,
  onClick,
  testid,
}: {
  glyph: string;
  label: string;
  disabled: boolean;
  active: boolean;
  onClick: () => void;
  testid: string;
}) {
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 3 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        style={iconBtn(active, disabled)}
        aria-label={label}
        aria-pressed={active}
        data-testid={testid}
      >
        {glyph}
      </button>
      <span style={{ fontSize: 10, color: stage.chromeFg, textShadow: stage.textShadow }}>
        {label.split(' ')[0]}
      </span>
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
      <div style={settingsRow}>
        <span style={settingsLabel}>Seconds per image</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
      </div>
      <div style={settingsRow}>
        <span style={settingsLabel}>Video loop count</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
      </div>
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

function topBar(c: Palette): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    background: `linear-gradient(${c.overlay}, transparent)`,
    zIndex: 5,
  };
}
const titleWrap: CSSProperties = { display: 'grid', flex: 1, minWidth: 0 };
const titleText: CSSProperties = {
  color: stage.chromeFg,
  fontWeight: 700,
  fontSize: 15,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textShadow: stage.textShadow,
};
const subText: CSSProperties = { color: stage.chromeFgDim, fontSize: 12, textShadow: stage.textShadow };
function buzzReadout(c: Palette): CSSProperties {
  return {
    color: stage.chromeFg,
    fontWeight: 700,
    fontSize: 13,
    fontVariantNumeric: 'tabular-nums',
    background: c.overlay,
    padding: '6px 10px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
  };
}

const rightRail: CSSProperties = {
  position: 'absolute',
  right: 10,
  bottom: 130,
  display: 'grid',
  gap: 14,
  zIndex: 6,
};

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
function progressText(): CSSProperties {
  return {
    color: stage.chromeFg,
    fontSize: 12,
    minWidth: 54,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    textShadow: stage.textShadow,
  };
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
const settingsRow: CSSProperties = { display: 'grid', gap: 6 };
const settingsLabel: CSSProperties = { fontSize: 13, fontWeight: 600, color: token.text };
const settingsValue: CSSProperties = {
  fontSize: 13,
  minWidth: 34,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  color: token.dimmed,
};

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
