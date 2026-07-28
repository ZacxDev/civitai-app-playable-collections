// CollectionViewer — the v0.1.6 shell around the three view modes.
//
// Owns the per-collection VIEW state (mode, media-type filter, seeded shuffle,
// pause) and the GLOBAL view prefs (mute, scroll speed), and renders:
//   - a persistent, pack-styled control surface (mode switcher + a settings
//     popover holding mute / shuffle / filter / speed / sec-per-image / loop),
//   - the active mode surface: classic <Player>, or a continuous <ContinuousView>,
//   - collection-level chrome (Follow + Tip curator) on the continuous modes,
//   - a lightbox: tapping a continuous tile opens the classic single-item Player
//     (Feature 3) with the full tip/follow/play controls.
//
// Data (items, paging, follow/tip/balance) stays in App; this component is view
// orchestration + local interaction. Mount it with `key={detail.id}` so the
// per-collection restore initializers re-run cleanly per collection.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Badge, Button, Card, Slider } from '@civitai/blocks-react/ui';

import type { CollectionDetail, MediaItem } from '../types.js';
import type { PlayerSettings } from '../settings.js';
import { getLocalStorage, SECONDS_PER_IMAGE, VIDEO_LOOP_COUNT } from '../settings.js';
import { elevate, mutedText, stage, token, type Palette } from '../theme.js';
import { useReducedMotion } from '../useMediaQuery.js';
import { DEFAULT_AUTOPLAY_CAP } from '../modes/autoplay.js';
import { maybeShuffle } from '../lib/shuffle.js';
import { filterByType, needsMoreToFill, type MediaFilter } from '../lib/media-filter.js';
import {
  loadCollectionState,
  saveCollectionState,
  SCROLL_SPEED,
  useViewPrefs,
  type ViewMode,
} from '../view-modes.js';
import { Player } from './Player.js';
import { ContinuousView } from './ContinuousView.js';
import { ModeSwitcher, SegmentedControl } from './ModeSwitcher.js';
import { TipModal, type TipTarget } from './TipModal.js';

export interface CollectionViewerProps {
  detail: CollectionDetail;
  items: MediaItem[];
  settings: PlayerSettings;
  onSecondsPerImageChange: (value: number) => void;
  onVideoLoopCountChange: (value: number) => void;
  viewerUserId: number | null;
  buzzBalance: number | null;
  followed: boolean;
  followPending: boolean;
  onToggleFollow: () => void;
  onTip: (target: TipTarget, amount: number) => Promise<boolean>;
  tipping: boolean;
  isMobile: boolean;
  c: Palette;
  onExit: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  // ---- test seams ----
  /** localStorage handle for view prefs + per-collection state. `undefined` →
   * the real device storage; pass an in-memory Storage (or null) in tests. */
  storage?: Storage | null;
  /** Override the `prefers-reduced-motion` result (tests). */
  reducedMotion?: boolean;
  /** Max concurrently-autoplaying feed videos (perf guard). */
  autoplayCap?: number;
}

export function CollectionViewer(props: CollectionViewerProps) {
  const {
    detail,
    items,
    settings,
    onSecondsPerImageChange,
    onVideoLoopCountChange,
    viewerUserId,
    buzzBalance,
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
    reducedMotion: reducedMotionProp,
    autoplayCap = DEFAULT_AUTOPLAY_CAP,
  } = props;

  const storage = props.storage === undefined ? getLocalStorage() : props.storage;

  const hookReducedMotion = useReducedMotion();
  const reducedMotion = reducedMotionProp ?? hookReducedMotion;

  const { prefs, toggleMuted, setScrollSpeed } = useViewPrefs(storage);

  // ---- per-collection restore (mode + position), once, keyed by detail.id ----
  const restored = useMemo(() => loadCollectionState(detail.id, storage), [detail.id, storage]);
  const [mode, setMode] = useState<ViewMode>(restored.mode);
  const [switchedMode, setSwitchedMode] = useState(false); // true after a manual switch
  const positionRef = useRef(restored.position);

  // ---- ephemeral per-session lenses ----
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [shuffleOn, setShuffleOn] = useState(false);
  const seed = detail.id; // stable per collection → deterministic order across reopen
  const [paused, setPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ---- lightbox + curator tip ----
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [tipCuratorOpen, setTipCuratorOpen] = useState(false);

  const curatorIsSelf = viewerUserId != null && detail.curator.userId === viewerUserId;

  // ---- the display list: (seeded shuffle) then (media-type filter). Pure. ----
  const displayItems = useMemo(
    () => filterByType(maybeShuffle(items, shuffleOn, seed), filter),
    [items, shuffleOn, seed, filter],
  );

  // Restore position only for the initial mode, and only until the user switches.
  const initialPosition = !switchedMode && mode === restored.mode ? restored.position : 0;

  // ---- persist mode + position ----
  const persist = useCallback(
    (nextMode: ViewMode) => saveCollectionState(detail.id, { mode: nextMode, position: positionRef.current }, storage),
    [detail.id, storage],
  );
  const changeMode = useCallback(
    (next: ViewMode) => {
      setSwitchedMode(true);
      positionRef.current = 0; // position meaning differs per mode; start fresh
      setMode(next);
      persist(next);
    },
    [persist],
  );
  // Save on unmount (exit / collection switch) capturing the final position.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    return () => saveCollectionState(detail.id, { mode: modeRef.current, position: positionRef.current }, storage);
  }, [detail.id, storage]);

  const exit = useCallback(() => {
    saveCollectionState(detail.id, { mode: modeRef.current, position: positionRef.current }, storage);
    onExit();
  }, [detail.id, storage, onExit]);

  // ---- filter re-page-to-fill: keep pulling pages while a filter starves the
  // view (bounded by the loader's page ceiling via `hasMore`). ----
  useEffect(() => {
    if (needsMoreToFill(filter, displayItems.length, hasMore, loadingMore)) onLoadMore?.();
  }, [filter, displayItems.length, hasMore, loadingMore, onLoadMore]);

  const onClassicPosition = useCallback((pos: number) => {
    positionRef.current = pos;
  }, []);
  const onContinuousOffset = useCallback((offset: number) => {
    positionRef.current = offset;
  }, []);

  const openLightbox = useCallback(
    (item: MediaItem) => {
      const idx = displayItems.findIndex((it) => it.mediaId === item.mediaId);
      setLightboxIndex(idx >= 0 ? idx : 0);
    },
    [displayItems],
  );

  const doCuratorTip = useCallback(
    async (amount: number) => {
      const ok = await onTip(
        {
          kind: 'curator',
          toUserId: detail.curator.userId,
          username: detail.curator.username,
          entityType: 'Collection',
          entityId: detail.id,
        },
        amount,
      );
      if (ok) setTipCuratorOpen(false);
    },
    [onTip, detail],
  );

  const isContinuous = mode !== 'classic';

  return (
    <div data-testid="collection-viewer" data-mode={mode} data-layout={isMobile ? 'mobile' : 'desktop'} style={rootStyle(c)}>
      {/* ---- control surface ---- */}
      <div style={toolbarStyle()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Button size="sm" variant="subtle" onClick={exit} data-testid="viewer-exit" aria-label="Back to collections">
            ←
          </Button>
          <div style={{ display: 'grid', minWidth: 0 }}>
            <span style={titleStyle} title={detail.name}>
              {detail.name}
            </span>
            <span style={subStyle}>
              {detail.curator.username ? `curated by ${detail.curator.username}` : 'curated collection'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <ModeSwitcher value={mode} onChange={changeMode} />
          <Button
            size="sm"
            variant={settingsOpen ? 'filled' : 'light'}
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            aria-label="View settings"
            data-testid="viewer-settings-toggle"
          >
            ⚙
          </Button>
          {viewerUserId != null && (
            <Badge size="lg" variant="light" data-testid="viewer-buzz">
              ⚡ {buzzBalance != null ? buzzBalance.toLocaleString() : '—'}
            </Badge>
          )}
        </div>
      </div>

      {/* ---- collection-level chrome + pause (continuous modes) ---- */}
      {isContinuous && (
        <div style={chromeRow()}>
          <Button
            size="sm"
            variant={paused ? 'filled' : 'light'}
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            data-testid="toggle-pause"
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </Button>
          <Button
            size="sm"
            variant={followed ? 'filled' : 'outline'}
            onClick={onToggleFollow}
            disabled={followPending}
            aria-pressed={followed}
            data-testid="chrome-follow"
          >
            {followed ? '★ Following' : '☆ Follow'}
          </Button>
          <Button
            size="sm"
            variant="light"
            onClick={() => setTipCuratorOpen(true)}
            disabled={curatorIsSelf || tipping}
            data-testid="chrome-tip-curator"
          >
            🎁 Tip curator
          </Button>
        </div>
      )}

      {/* ---- settings popover ---- */}
      {settingsOpen && (
        <Card padding="md" data-testid="viewer-settings" style={settingsCard}>
          <div style={settingRow}>
            <span style={settingLabel}>Audio</span>
            <Button
              size="sm"
              variant={prefs.muted ? 'outline' : 'filled'}
              onClick={toggleMuted}
              aria-pressed={!prefs.muted}
              data-testid="toggle-mute"
            >
              {prefs.muted ? '🔇 Muted' : '🔊 Sound on'}
            </Button>
          </div>

          <div style={settingRow}>
            <span style={settingLabel}>Shuffle</span>
            <Button
              size="sm"
              variant={shuffleOn ? 'filled' : 'outline'}
              onClick={() => setShuffleOn((s) => !s)}
              aria-pressed={shuffleOn}
              data-testid="toggle-shuffle"
            >
              🔀 {shuffleOn ? 'On' : 'Off'}
            </Button>
          </div>

          <div style={settingRow}>
            <span style={settingLabel}>Show</span>
            <SegmentedControl<MediaFilter>
              value={filter}
              onChange={setFilter}
              ariaLabel="Filter media type"
              testid="filter"
              size="sm"
              options={[
                { value: 'all', label: 'All' },
                { value: 'images', label: 'Images' },
                { value: 'videos', label: 'Videos' },
              ]}
            />
          </div>

          {isContinuous ? (
            <div style={settingRow}>
              <span style={settingLabel}>Scroll speed</span>
              <span style={sliderWrap}>
                <Slider
                  min={SCROLL_SPEED.min}
                  max={SCROLL_SPEED.max}
                  step={5}
                  value={prefs.scrollSpeed}
                  onChange={setScrollSpeed}
                  aria-label="Auto-scroll speed"
                  data-testid="set-scroll-speed"
                  style={{ flex: 1 }}
                />
                <span style={sliderValue} data-testid="scroll-speed-value">
                  {prefs.scrollSpeed}
                </span>
              </span>
            </div>
          ) : (
            <>
              <div style={settingRow}>
                <span style={settingLabel}>Seconds / image</span>
                <span style={sliderWrap}>
                  <Slider
                    min={SECONDS_PER_IMAGE.min}
                    max={SECONDS_PER_IMAGE.max}
                    step={1}
                    value={settings.secondsPerImage}
                    onChange={onSecondsPerImageChange}
                    aria-label="Seconds per image"
                    data-testid="set-seconds-per-image"
                    style={{ flex: 1 }}
                  />
                  <span style={sliderValue} data-testid="seconds-per-image-value">
                    {settings.secondsPerImage}s
                  </span>
                </span>
              </div>
              <div style={settingRow}>
                <span style={settingLabel}>Video loops</span>
                <span style={sliderWrap}>
                  <Slider
                    min={VIDEO_LOOP_COUNT.min}
                    max={VIDEO_LOOP_COUNT.max}
                    step={1}
                    value={settings.videoLoopCount}
                    onChange={onVideoLoopCountChange}
                    aria-label="Video loop count"
                    data-testid="set-video-loop-count"
                    style={{ flex: 1 }}
                  />
                  <span style={sliderValue} data-testid="video-loop-count-value">
                    {settings.videoLoopCount}×
                  </span>
                </span>
              </div>
            </>
          )}
        </Card>
      )}

      {/* ---- the active mode surface ---- */}
      <div style={{ position: 'relative' }}>
        {mode === 'classic' ? (
          <Player
            detail={detail}
            items={displayItems}
            settings={settings}
            onSecondsPerImageChange={onSecondsPerImageChange}
            onVideoLoopCountChange={onVideoLoopCountChange}
            viewerUserId={viewerUserId}
            buzzBalance={buzzBalance}
            muted={prefs.muted}
            initialItemIndex={initialPosition}
            onPositionChange={onClassicPosition}
            showSettingsControl={false}
            followed={followed}
            followPending={followPending}
            onToggleFollow={onToggleFollow}
            onTip={onTip}
            tipping={tipping}
            isMobile={isMobile}
            c={c}
            onExit={exit}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={onLoadMore}
          />
        ) : (
          <ContinuousView
            orientation={mode === 'continuous-horizontal' ? 'horizontal' : 'vertical'}
            items={displayItems}
            muted={prefs.muted}
            scrollSpeed={prefs.scrollSpeed}
            reducedMotion={reducedMotion}
            paused={paused}
            autoplayCap={autoplayCap}
            c={c}
            onTapItem={openLightbox}
            onTogglePause={() => setPaused((p) => !p)}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={onLoadMore}
            initialOffset={initialPosition}
            onOffsetChange={onContinuousOffset}
          />
        )}
      </div>

      {displayItems.length === 0 && (
        <div style={emptyNote()} data-testid="viewer-empty">
          {filter === 'all' ? 'This collection has no playable media.' : `No ${filter} in what's loaded yet.`}
        </div>
      )}

      {/* ---- lightbox: the classic single-item view over a continuous surface ---- */}
      {lightboxIndex != null && (
        <div style={lightboxOverlay} data-testid="lightbox">
          <Player
            detail={detail}
            items={displayItems}
            settings={settings}
            onSecondsPerImageChange={onSecondsPerImageChange}
            onVideoLoopCountChange={onVideoLoopCountChange}
            viewerUserId={viewerUserId}
            buzzBalance={buzzBalance}
            muted={prefs.muted}
            initialItemIndex={lightboxIndex}
            followed={followed}
            followPending={followPending}
            onToggleFollow={onToggleFollow}
            onTip={onTip}
            tipping={tipping}
            isMobile={isMobile}
            c={c}
            onExit={() => setLightboxIndex(null)}
          />
        </div>
      )}

      {/* ---- curator tip (continuous chrome) ---- */}
      {tipCuratorOpen && (
        <TipModal
          target={{
            kind: 'curator',
            toUserId: detail.curator.userId,
            username: detail.curator.username,
            entityType: 'Collection',
            entityId: detail.id,
          }}
          balance={buzzBalance}
          submitting={tipping}
          onConfirm={doCuratorTip}
          onClose={() => setTipCuratorOpen(false)}
        />
      )}
    </div>
  );
}

// ---- styles ----
function rootStyle(c: Palette): CSSProperties {
  return { position: 'relative', width: '100%', minHeight: '100dvh', background: c.bg, color: c.fg, fontFamily: token.font };
}
function toolbarStyle(): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '10px 14px',
    borderBottom: `1px solid ${token.border}`,
    background: token.surface,
    flexWrap: 'wrap',
  };
}
const titleStyle: CSSProperties = { fontWeight: 700, fontSize: 15, color: token.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const subStyle: CSSProperties = { fontSize: 12, color: token.dimmed };
function chromeRow(): CSSProperties {
  return {
    display: 'flex',
    gap: 8,
    padding: '8px 14px',
    alignItems: 'center',
    borderBottom: `1px solid ${token.border}`,
    // A faint recess that reads in BOTH themes — never surface-2 (== body in light).
    background: elevate(4),
    flexWrap: 'wrap',
  };
}
const settingsCard: CSSProperties = { display: 'grid', gap: 10, margin: '10px 14px' };
const settingRow: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
const settingLabel: CSSProperties = { fontSize: 13, fontWeight: 600, minWidth: 96, color: token.text };
const sliderWrap: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flex: 1, maxWidth: 260 };
const sliderValue: CSSProperties = { fontSize: 13, minWidth: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: token.dimmed };
function emptyNote(): CSSProperties {
  return { padding: 40, textAlign: 'center', ...mutedText };
}
const lightboxOverlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  background: stage.bg,
};
