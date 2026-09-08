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

import { Button, Card, FollowButton, Slider } from '@civitai/blocks-react/ui';

import type { CollectionDetail, MediaItem } from '../types.js';
import type { PlayerSettings } from '../settings.js';
import { getLocalStorage, SECONDS_PER_IMAGE, VIDEO_LOOP_COUNT } from '../settings.js';
import type { Palette } from '../theme.js';
import { useReducedMotion } from '../useMediaQuery.js';
import { DEFAULT_AUTOPLAY_CAP } from '../modes/autoplay.js';
import { maybeShuffle } from '../lib/shuffle.js';
import { filterToCeiling } from '../lib/maturity.js';
import { useViewerCeiling } from '../lib/viewer-maturity.js';
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
import { TipModal, type TipSender } from './TipModal.js';
import type { PlannedLeg } from './TipSplitModal.js';
import { FocusTrap } from './FocusTrap.js';

export interface CollectionViewerProps {
  detail: CollectionDetail;
  items: MediaItem[];
  settings: PlayerSettings;
  onSecondsPerImageChange: (value: number) => void;
  onVideoLoopCountChange: (value: number) => void;
  viewerUserId: number | null;
  buzzBalance: number | null;
  followed: boolean;
  /** Adopt the host's echo after a confirmed follow write (host bridge). */
  onFollowChange: (collectionId: number, followed: boolean) => void;
  /** Surface a renderable message from the follow bridge (Player's rail). */
  onNotice: (kind: 'success' | 'error' | 'info', message: string) => void;
  /**
   * A follow whose outcome is UNKNOWN (transport timeout, or a code-less server
   * error raised after the row may already have committed) — drop cached reads.
   *
   * 🔴 REQUIRED. While optional, an audit deleted this prop AND both forwards to
   * Player below and the entire suite stayed green — see PlayerProps.
   */
  onFollowUncertain: () => void;
  onTip: TipSender;
  /** Prompt a logged-out viewer to sign in (tipping requires an account). */
  onRequestSignIn?: () => void;
  tipping: boolean;
  /**
   * The viewer's REAL remaining daily tip allowance, read once per view from the
   * server (0.2.10). Omitted while that read is unresolved or after it failed —
   * the pickers then fall back to the full cap and let the server decide, so a
   * failed read never makes tipping impossible.
   */
  dailyTipRemaining?: number;
  /**
   * Split-tip plans, owned by App. Forwarded VERBATIM to both Players (the mode
   * surface and the lightbox) so a half-failed split survives a mode switch, the
   * lightbox opening/closing, and this component unmounting.
   */
  splitPlans: Readonly<Record<string, PlannedLeg[]>>;
  onSplitPlanChange: (key: string, plan: PlannedLeg[] | null) => void;
  isMobile: boolean;
  c: Palette;
  onExit: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  // ---- deep-link (Feature #6) ----
  /** Deep-link override for the starting view mode (else localStorage restore). */
  initialMode?: ViewMode;
  /** Deep-link override for the starting item index (else localStorage restore). */
  initialIndex?: number;
  /** Reports the current {mode, index} up so App can keep the URL hash in sync. */
  onViewStateChange?: (state: { mode: ViewMode; index: number }) => void;
  /** Share the current collection/position (Web Share / copy-link). */
  onShare?: () => void;
  /** Fires when cast (ambient) mode is entered/exited — for analytics. */
  onCast?: (on: boolean) => void;
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
    onFollowChange,
    onNotice,
    onFollowUncertain,
    onTip,
    onRequestSignIn,
    tipping,
    dailyTipRemaining,
    splitPlans,
    onSplitPlanChange,
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
  // A deep-link (Feature #6) override wins over the localStorage restore.
  const restored = useMemo(() => loadCollectionState(detail.id, storage), [detail.id, storage]);
  const initMode = props.initialMode ?? restored.mode;
  const initPosition = props.initialIndex ?? restored.position;
  const [mode, setMode] = useState<ViewMode>(initMode);
  const [switchedMode, setSwitchedMode] = useState(false); // true after a manual switch
  const positionRef = useRef(initPosition);

  // ---- ephemeral per-session lenses ----
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [shuffleOn, setShuffleOn] = useState(false);
  const seed = detail.id; // stable per collection → deterministic order across reopen
  const [paused, setPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Ambient "cast" mode (#8): full-bleed, chrome hidden, passive auto-advance.
  const [cast, setCast] = useState(false);
  const onCastRef = useRef(props.onCast);
  onCastRef.current = props.onCast;
  const enterCast = useCallback(() => {
    setCast(true);
    onCastRef.current?.(true);
  }, []);
  const exitCast = useCallback(() => {
    setCast(false);
    onCastRef.current?.(false);
  }, []);
  // ---- lightbox + curator tip ----
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [tipCuratorOpen, setTipCuratorOpen] = useState(false);

  const curatorIsSelf = viewerUserId != null && detail.curator.userId === viewerUserId;

  // ---- the display list: (maturity ceiling) → (seeded shuffle) → (media-type
  // filter). Pure, and this is the ONE list every index in this component means.
  //
  // 🔴 THE CEILING FILTER RUNS FIRST, AND IT HAS TO RUN HERE. `openLightbox`
  // resolves a tapped tile to an INDEX into `displayItems` and hands it to Player
  // as `initialItemIndex`; if this list still held items the surfaces had dropped,
  // every index past a dropped item would be off by one and the lightbox would
  // open on the wrong media. Both surfaces re-apply the same filter defensively —
  // it is idempotent, so their lists and this one are the same list.
  //
  // It is a filter in exactly the sense the media-type filter already is, so the
  // things that depend on list length (the scrubber max, `progressLabel`, the
  // "no playable media" note, `needsMoreToFill`) all keep agreeing with what is on
  // screen. `CollectionSummary.itemCount` on a discover card is a SERVER count and
  // is untouched by this — it was already a count of items before any client-side
  // lens, and the server clamps the detail read anyway, so in practice this filter
  // removes nothing and is a net rather than a lens.
  const ceiling = useViewerCeiling();
  const displayItems = useMemo(
    () => filterByType(maybeShuffle(filterToCeiling(items, ceiling), shuffleOn, seed), filter),
    [items, ceiling, shuffleOn, seed, filter],
  );

  // Restore position only for the initial mode, and only until the user switches.
  const initialPosition = !switchedMode && mode === initMode ? initPosition : 0;

  // Report {mode, index} up so App can keep the shareable URL hash in sync (#6).
  const onViewStateChangeRef = useRef(props.onViewStateChange);
  onViewStateChangeRef.current = props.onViewStateChange;
  const reportViewState = useCallback((m: ViewMode, idx: number) => {
    onViewStateChangeRef.current?.({ mode: m, index: m === 'classic' ? Math.max(0, Math.floor(idx)) : 0 });
  }, []);

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
      reportViewState(next, 0);
    },
    [persist, reportViewState],
  );
  // Save on unmount (exit / collection switch) capturing the final position.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    return () => saveCollectionState(detail.id, { mode: modeRef.current, position: positionRef.current }, storage);
  }, [detail.id, storage]);

  // Report the initial {mode, index} once per opened collection (deep-link sync).
  useEffect(() => {
    reportViewState(modeRef.current, positionRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  const exit = useCallback(() => {
    saveCollectionState(detail.id, { mode: modeRef.current, position: positionRef.current }, storage);
    onExit();
  }, [detail.id, storage, onExit]);

  // ---- filter re-page-to-fill: keep pulling pages while a filter starves the
  // view (bounded by the loader's page ceiling via `hasMore`). ----
  useEffect(() => {
    if (needsMoreToFill(filter, displayItems.length, hasMore, loadingMore)) onLoadMore?.();
  }, [filter, displayItems.length, hasMore, loadingMore, onLoadMore]);

  const onClassicPosition = useCallback(
    (pos: number) => {
      positionRef.current = pos;
      reportViewState('classic', pos);
    },
    [reportViewState],
  );
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
    <div data-testid="collection-viewer" data-mode={mode} data-cast={cast ? 'on' : 'off'} data-layout={isMobile ? 'mobile' : 'desktop'} style={rootStyle(c)}>
      {/* ---- control surface (hidden in cast mode) ---- */}
      {!cast && (
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
            variant="light"
            onClick={enterCast}
            aria-pressed={false}
            aria-label="Ambient — full-screen passive playback"
            data-testid="cast-toggle"
          >
            📺 Ambient
          </Button>
          {props.onShare && (
            <Button size="sm" variant="light" onClick={props.onShare} aria-label="Share this collection" data-testid="viewer-share">
              🔗 Share
            </Button>
          )}
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
          {/* A "⚡ <balance>" Buzz pill sat here. Removed 2026-09-05 with the two
              other readouts (App header, Player top overlay). 🔴 `buzzBalance` is
              STILL a required prop and is still forwarded to Player and to the
              curator TipModal below, which pre-validates a tip against it — the
              badge went, the balance did not. */}
        </div>
      </div>
      )}

      {/* The one-time "How to play" coach card (#10) stood here until 0.2.14.
          Removed on operator feedback: the controls are discoverable enough that a
          card explaining them was chrome in front of the content it described.
          🔴 Do not "restore the onboarding" — the affordance was deliberately
          deleted, not lost. `src/lib/onboarding.ts` went with it; the only thing
          that ever read its `localStorage` key was this card. A returning viewer
          may still carry that orphaned key, which nothing reads. */}

      {/* ---- cast mode: a single floating exit affordance (chrome is hidden) ---- */}
      {cast && (
        <button type="button" onClick={exitCast} style={castExitStyle} data-testid="cast-exit" aria-label="Exit ambient mode">
          ✕ Exit ambient
        </button>
      )}

      {/* ---- collection-level chrome + pause (continuous modes) ---- */}
      {isContinuous && !cast && (
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
          {/* 🔴 UPSTREAM CONTROL, NOT A HAND-ROLLED ONE (0.2.10). This row's
              button was already a `Button` with the same size + variant shape,
              so adopting `FollowButton` costs almost no visual change here (the
              `☆`/`★` glyphs DO go — the labels become plain "Follow" /
              "Following") and buys the
              three outcomes a hand-rolled follow reliably gets wrong: `declined`
              renders NOTHING (the viewer dismissed the host's confirm — the old
              code toasted an error at them), `sign-in-required` routes to
              sign-in rather than an error line, and the optimistic flip is
              replaced by the HOST'S ECHO instead of the guess.

              `variant` names the NOT-following state; the following state is
              always `light` upstream so the two are distinguishable without
              reading the label. That inverts this app's old filled/outline
              pairing, which is the one deliberate visual delta. */}
          <FollowButton
            size="sm"
            variant="outline"
            collectionId={detail.id}
            collectionName={detail.name}
            followed={followed}
            // Upstream's `onChange` reports only the flag, so supply the id this
            // control is BOUND to. That is safe where deriving it from "what is
            // open" is not: the binding cannot drift mid-flight, because a
            // different collection remounts this subtree (`key={detail.id}`).
            onChange={(f) => onFollowChange(detail.id, f)}
            data-testid="chrome-follow"
          />
          <Button
            size="sm"
            variant="light"
            onClick={() => (viewerUserId == null ? onRequestSignIn?.() : setTipCuratorOpen(true))}
            disabled={curatorIsSelf || tipping}
            title={curatorIsSelf ? "You can't tip your own collection." : undefined}
            data-testid="chrome-tip-curator"
          >
            🎁 Tip curator
          </Button>
        </div>
      )}

      {/* ---- settings popover ---- */}
      {settingsOpen && !cast && (
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
            <label style={settingRow}>
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
            </label>
          ) : (
            <>
              <label style={settingRow}>
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
              </label>
              <label style={settingRow}>
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
              </label>
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
            onFollowChange={onFollowChange}
            onNotice={onNotice}
            onFollowUncertain={onFollowUncertain}
            onTip={onTip}
            onRequestSignIn={onRequestSignIn}
            tipping={tipping}
            dailyTipRemaining={dailyTipRemaining}
            splitPlans={splitPlans}
            onSplitPlanChange={onSplitPlanChange}
            cast={cast}
            reducedMotion={reducedMotion}
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
        <div style={emptyNote(c)} data-testid="viewer-empty">
          {filter === 'all' ? 'This collection has no playable media.' : `No ${filter} in what's loaded yet.`}
        </div>
      )}

      {/* ---- lightbox: the classic single-item view over a continuous surface ---- */}
      {lightboxIndex != null && (
        <div style={lightboxOverlay} data-testid="lightbox" role="dialog" aria-modal="true" aria-label="Media viewer">
          <FocusTrap autoFocus restoreFocus>
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
            onFollowChange={onFollowChange}
            onNotice={onNotice}
            onFollowUncertain={onFollowUncertain}
            onTip={onTip}
            onRequestSignIn={onRequestSignIn}
            tipping={tipping}
            dailyTipRemaining={dailyTipRemaining}
            splitPlans={splitPlans}
            onSplitPlanChange={onSplitPlanChange}
            isMobile={isMobile}
            c={c}
            onExit={() => setLightboxIndex(null)}
          />
          </FocusTrap>
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
          dailyRemaining={dailyTipRemaining}
          onConfirm={doCuratorTip}
          onClose={() => setTipCuratorOpen(false)}
        />
      )}
    </div>
  );
}

// ---- styles ----
function rootStyle(c: Palette): CSSProperties {
  return { position: 'relative', width: '100%', minHeight: '100dvh', background: c.bg, color: c.fg, fontFamily: 'var(--civitai-font)' };
}
function toolbarStyle(): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '10px 14px',
    borderBottom: '1px solid var(--civitai-color-border)',
    background: 'var(--civitai-color-surface)',
    flexWrap: 'wrap',
  };
}
const titleStyle: CSSProperties = { fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const subStyle: CSSProperties = { fontSize: 12, color: 'var(--civitai-color-text-dimmed)' };
function chromeRow(): CSSProperties {
  return {
    display: 'flex',
    gap: 8,
    padding: '8px 14px',
    alignItems: 'center',
    borderBottom: '1px solid var(--civitai-color-border)',
    background: 'var(--civitai-color-surface-2)',
    flexWrap: 'wrap',
  };
}
const settingsCard: CSSProperties = { display: 'grid', gap: 10, margin: '10px 14px' };
const settingRow: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
const settingLabel: CSSProperties = { fontSize: 13, fontWeight: 600, minWidth: 96 };
const sliderWrap: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flex: 1, maxWidth: 260 };
const sliderValue: CSSProperties = { fontSize: 13, minWidth: 40, textAlign: 'right' };
function emptyNote(c: Palette): CSSProperties {
  return { padding: 40, textAlign: 'center', color: c.muted };
}
const lightboxOverlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  background: '#000',
};
const castExitStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 40,
  padding: '6px 12px',
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.25)',
  background: 'rgba(0,0,0,0.45)',
  color: '#fff',
  fontSize: 13,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
