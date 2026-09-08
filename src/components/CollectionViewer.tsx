// CollectionViewer — the shell around the three view modes.
//
// Owns the per-collection VIEW state (mode, media-type filter, seeded shuffle,
// pause) and the GLOBAL view prefs (mute, scroll speed), and renders:
//   - a persistent, pack-styled control surface (mode switcher + a settings
//     popover holding mute / shuffle / filter / speed / sec-per-image / loop),
//   - the ONE viewer-action row (Follow + Tip) — see below,
//   - the active mode surface: classic <Player>, or a continuous <ContinuousView>,
//   - a lightbox: tapping a continuous tile opens the classic single-item Player
//     (Feature 3).
//
// 🔴 THE VIEWER-ACTION ROW IS RENDERED FROM ONE PLACE, ON PURPOSE (T5).
// `viewerActionRow()` below is called from exactly two branches — the normal
// surface, and INSIDE the lightbox, which is `aria-modal` and covers the normal
// one — and never from both at once. That is what makes "exactly ONE tip
// affordance per view" a structural fact rather than a styling convention:
// `getAllByTestId('chrome-tip')` has length 1 in Slideshow, in Ticker, in Wall
// and with the lightbox open, and `src/components/tip-affordance.test.tsx`
// asserts exactly that. Before T5 the row existed only on the continuous modes
// and carried a curator tip alone, while `Player` drew a SEPARATE four-button
// rail — so the two surfaces disagreed on placement, on component AND on which
// actions existed at all, and a viewer could not tip a creator from Ticker or
// Wall at all.
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
import type { TipSender } from '../lib/tip-target.js';
import { TipSplitModal, splitTipKey, type PlannedLeg, type SplitRecipient } from './TipSplitModal.js';
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
   * Split-tip plans, owned by App.
   *
   * 🔴 THEY STAY IN App EVEN THOUGH THE PICKER MOVED HERE. This component is
   * unmounted by leaving the collection and remounted (`key={detail.id}`) by
   * opening a different one, so a plan owned here would still die on one of the
   * four ordinary actions the plan exists to survive. Read the header of
   * TipSplitModal for what a lost plan costs: a re-confirm mints fresh keys, the
   * server has nothing to replay, and a leg that already landed is paid twice.
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
  // ---- lightbox ----
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // ---- which media the tip picker would name as "the creator" ----
  //
  // 🔴 TWO SLOTS, NOT ONE, AND THAT IS A RACE FIX RATHER THAN TIDINESS. When the
  // lightbox is open over a continuous surface, BOTH are mounted and BOTH report
  // — the wall keeps reporting its first in-view tile while the lightbox Player
  // reports the item the viewer actually tapped. Merged into one slot, whichever
  // fired last would win, so the recipient a press froze would depend on render
  // order. Kept apart, the lightbox's own item wins for exactly as long as the
  // lightbox is up, deterministically, and closing it restores the surface's.
  const [surfaceItem, setSurfaceItem] = useState<MediaItem | null>(null);
  const [lightboxItem, setLightboxItem] = useState<MediaItem | null>(null);
  const currentItem = lightboxIndex != null ? lightboxItem : surfaceItem;

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
      // 🔴 DO NOT ALSO SEED `lightboxItem` FROM THE TAPPED TILE HERE. It looks
      // prudent — this callback HAS the item — and it was written that way for one
      // round, but the lightbox Player reports through a LAYOUT effect, which is
      // flushed inside the very commit that mounts it. So the slot is correct
      // before anything can be painted or pressed, and a second writer for the same
      // value is a second source of truth with no way to observe it being wrong:
      // both a seed here and a clear on close survived as mutants against the whole
      // suite, which is what unfalsifiable duplication looks like. The stale window
      // they were added to close is closed at its source (`Player.tsx`, search
      // `useLayoutEffect`), and the two commit-ordering probes are what guard it.
    },
    [displayItems],
  );

  const closeLightbox = useCallback(() => setLightboxIndex(null), []);

  // =========================================================================
  // The ONE tip affordance
  // =========================================================================
  //
  // 🔴 `null` MEANS "THIS SIDE DOES NOT EXIST", NOT "DISABLED". The server 403s a
  // self-tip, so offering the leg and letting it fail would take the viewer's
  // confirmation and then half-fail. `splitTipTotal` gives the whole total to the
  // surviving side, and the picker says why.
  //
  // 🔴 THESE TWO ARE THE LIVE DERIVATION. They decide whether the control is
  // OFFERED and what to FREEZE when it is pressed. Nothing downstream of the
  // press may read them again — re-reading them after the press is the exact
  // 0.2.10 defect (the media auto-advances every few seconds, so a picker held
  // open across one interval paid the NEXT item's creator against the NEXT
  // item's id, while the viewer had read a preview naming someone else).
  const liveCreator: SplitRecipient =
    currentItem != null && !(viewerUserId != null && currentItem.creator.userId === viewerUserId)
      ? {
          kind: 'creator',
          toUserId: currentItem.creator.userId,
          username: currentItem.creator.username,
          entityType: 'Image',
          entityId: currentItem.mediaId,
        }
      : null;
  const liveCurator: SplitRecipient = curatorIsSelf
    ? null
    : {
        kind: 'curator',
        toUserId: detail.curator.userId,
        username: detail.curator.username,
        entityType: 'Collection',
        entityId: detail.id,
      };
  // Both sides collapsed = the viewer owns the media AND the collection; there is
  // nobody to pay, so the control is disabled rather than opening an empty picker.
  const tipPossible = liveCreator != null || liveCurator != null;

  /** The FROZEN pair the open picker is for. `null` = no picker open. */
  const [tipOpenFor, setTipOpenFor] = useState<{ creator: SplitRecipient; curator: SplitRecipient } | null>(null);
  /** Reported up by the picker: a leg is on the wire, so nothing may dismiss it. */
  const [tipSending, setTipSending] = useState(false);


  const openTip = useCallback(() => {
    // Logged-out: tipping needs an account, so prompt sign-in UP FRONT rather
    // than opening the amount picker and bouncing only after a selection.
    if (viewerUserId == null) {
      onRequestSignIn?.();
      return;
    }
    if (!tipPossible) return;
    // 🔴 FREEZE BOTH SIDES HERE. Everything the picker sends, previews and
    // reports back is resolved from this snapshot, so the media underneath may
    // move (a timer, a filter, a reload, a wall scrolling on) without
    // redirecting a single Buzz.
    setTipOpenFor({ creator: liveCreator, curator: liveCurator });
  }, [viewerUserId, onRequestSignIn, tipPossible, liveCreator, liveCurator]);

  /**
   * The media ON SCREEN RIGHT NOW has money outstanding — a plan exists for the tip
   * whose recipients it names, so at least one leg is unsent (a completed tip
   * DELETES its plan, and so does an explicit discard).
   *
   * 🔴 DERIVED FROM THE LIVE MEDIA, NEVER REMEMBERED IN THIS COMPONENT'S STATE.
   * The first version of this hold stored "the tip the viewer last opened" in a
   * `useState` here — and `App` mounts this component as `key={detail.id}`, so
   * LEAVING THE COLLECTION reset it to null while the plan itself (owned by App,
   * on purpose) survived. Reopening came back UNHELD with money still outstanding
   * and re-armed the exact drift below, on the single action the plan is designed
   * to survive. Derived, it cannot go stale and cannot outlive its subject: the
   * per-collection position restore puts the same media back on screen, the key
   * matches again, and the hold re-engages by itself.
   *
   * 🔴 THIS IS WHY THE APP MUST NOT START MOTION BY ITSELF. The plan is keyed to
   * the MEDIA, and the picker promises in so many words that "reopening this split
   * picks the same tip back up". Closing the picker used to RESUME the transport,
   * so five seconds of doing nothing advanced the item, moved the key, orphaned the
   * outstanding leg and handed the viewer a blank Send — which mints a FRESH
   * idempotency key for a transfer whose predecessor may already have landed. On
   * Ticker and Wall it needs no viewer action at all, because they auto-scroll.
   *
   * 🔴 THE FIX IS NOT TO RE-POINT THE KEY. A different image genuinely IS a
   * different tip — resuming the old plan there would show a viewer a
   * partial-failure panel and a Retry for a tip they never started on this media,
   * and pressing it would replay keys against the wrong entity. So the app simply
   * declines to move on its own while money is outstanding. The viewer can still
   * press Play, or navigate: that is a deliberate act, and it forfeits the plan
   * visibly rather than behind their back.
   */
  const outstandingTip = splitPlans[splitTipKey(liveCreator, liveCurator)] != null;

  // The logical tip the open picker is for, and the plan App is holding for it.
  const openTipKey = tipOpenFor ? splitTipKey(tipOpenFor.creator, tipOpenFor.curator) : null;
  const openTipPlan = openTipKey != null ? (splitPlans[openTipKey] ?? null) : null;

  const pickerOpen = tipOpenFor != null;

  /**
   * Every leg landed — retire the plan and close.
   *
   * 🔴 THE PLAN IS RETIRED, AND THAT DELETION IS LOAD-BEARING. `splitTipKey` is
   * per-MEDIA, so a retained completed plan makes reopening the picker on the
   * media just tipped resume it: the amount, the presets, the recipient row and
   * Send are all locked by `plan != null`, and `failed` is false so no Retry ever
   * appears — a picker with no action at all, recoverable only by reloading.
   */
  const onTipDone = useCallback(() => {
    if (openTipKey != null) onSplitPlanChange(openTipKey, null);
    setTipOpenFor(null);
    // Nothing clears a "hold" flag here: deleting the plan IS what releases the
    // surfaces, because `outstandingTip` is derived from the plan store.
  }, [openTipKey, onSplitPlanChange]);

  // 🔴 THE APP'S OWN Escape GATE. ⚠️ AN EARLIER VERSION OF THIS COMMENT CLAIMED
  // THIS HANDLER IS WHAT REFUSES A MID-SEND DISMISSAL, AND THAT WAS WRONG ABOUT
  // THE ORDERING. A real Escape from the focused dialog bubbles target → document
  // → window, and `Modal`'s own listener is on `document`, so the MODAL decides
  // first; this handler cannot prevent a dismissal it has already allowed. The
  // load-bearing mid-send gate is `closeOnEscape={!sending}` inside
  // `TipSplitModal`, and it must stay there.
  //
  // What THIS handler is genuinely for: closing the picker for key events that
  // never reach `document` at all, and being the app's own record of the same
  // decision so the two cannot disagree. `tipping`/`tipSending` are checked here
  // for that reason — belt and braces with the modal's gate, not instead of it.
  // (The covering test dispatches on `window`, whose propagation path is `window`
  // alone, so it exercises THIS gate and never the modal's. Do not read it as
  // evidence about the modal's.)
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (tipSending || tipping) return;
      setTipOpenFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen, tipSending, tipping]);

  const isContinuous = mode !== 'classic';

  /**
   * The ONE viewer-action row: Follow, Tip, and (continuous only) Pause.
   *
   * 🔴 CALLED FROM EXACTLY TWO BRANCHES AND NEVER BOTH — see this file's header.
   * If you add a third call site, add it to the affordance-count test in the same
   * commit, because "exactly one" is the acceptance criterion, not a preference.
   */
  const viewerActionRow = () => (
    <div style={chromeRow()} data-testid="viewer-actions">
      {isContinuous && lightboxIndex == null && (
        // 🔴 IT REPORTS THE EFFECTIVE STATE, NOT THE LOCAL FLAG. While a tip is
        // outstanding the surface is held still by `outstandingTip`, and a control
        // rendering only `paused` sat there reading "⏸ Pause" over an already-
        // stopped wall — and did nothing when pressed, twice, with no explanation
        // anywhere on screen. A control that misreports the thing it controls is
        // worse than a disabled one, so this one says why it is disabled.
        <Button
          size="sm"
          variant={paused || outstandingTip ? 'filled' : 'light'}
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused || outstandingTip}
          disabled={outstandingTip}
          title={
            outstandingTip
              ? 'Paused while part of your tip is still unsent — retry it, or start a new tip.'
              : undefined
          }
          data-testid="toggle-pause"
        >
          {paused || outstandingTip ? '▶ Resume' : '⏸ Pause'}
        </Button>
      )}
      {/* 🔴 UPSTREAM CONTROL, NOT A HAND-ROLLED ONE, IN ALL THREE VIEWS (T5
          criterion 3). It buys the three outcomes a hand-rolled follow reliably
          gets wrong: `declined` renders NOTHING (the viewer dismissed the host's
          confirm — the app's old glyph rail toasted an error at them),
          `sign-in-required` routes to sign-in rather than an error line, and the
          optimistic flip is replaced by the HOST'S ECHO instead of the guess.

          `variant` names the NOT-following state; the following state is always
          `light` upstream so the two are distinguishable without reading the
          label. That inverts this app's old filled/outline pairing, which is the
          one deliberate visual delta.

          ⚠️ WHAT WENT WITH THE HAND-ROLLED CONTROL, RECORDED RATHER THAN
          GLOSSED: `useFollowToggle` reported a TIMEOUT and a code-less server
          error as AMBIGUOUS and dropped the app's read cache, because either can
          be raised after the row committed. `FollowButton` exposes no failure
          callback at all, so the app cannot learn that happened and the cache
          drop has no equivalent here. The exposure is a stale `followed` flag for
          the cache TTL after an ambiguous write — no money, no writes. Closing it
          properly is an upstream prop, not a workaround in this repo. */}
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
        onClick={openTip}
        disabled={!tipPossible || tipping}
        title={
          !tipPossible
            ? "This is your own media in your own collection — there's no one to tip."
            : undefined
        }
        data-testid="chrome-tip"
      >
        💸 Tip
      </Button>
    </div>
  );

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
              tip picker below, which pre-validates a tip against it — the
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

      {/* ---- the ONE viewer-action row — every mode, hidden only in ambient ----
          Suppressed while the lightbox is up, because the lightbox renders this
          same row inside itself: `aria-modal` covers this one, so rendering both
          would put a second, unreachable tip button in the DOM and make "exactly
          one affordance" false while looking correct on screen. */}
      {!cast && lightboxIndex == null && viewerActionRow()}

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
            items={displayItems}
            settings={settings}
            onSecondsPerImageChange={onSecondsPerImageChange}
            onVideoLoopCountChange={onVideoLoopCountChange}
            muted={prefs.muted}
            initialItemIndex={initialPosition}
            onPositionChange={onClassicPosition}
            onCurrentItemChange={setSurfaceItem}
            showSettingsControl={false}
            pickerOpen={pickerOpen}
            holdPaused={outstandingTip}
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
            // 🔴 THE PICKER PAUSES THE DRIFT TOO (T5 criterion 5). Without this
            // the wall keeps scrolling under an open picker: the money is still
            // right (the recipients are frozen at press time), but the viewer is
            // reading a preview naming a creator whose tile has left the screen.
            paused={paused || pickerOpen || outstandingTip}
            autoplayCap={autoplayCap}
            c={c}
            onTapItem={openLightbox}
            onCurrentItemChange={setSurfaceItem}
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
        <div
          style={lightboxOverlay}
          data-testid="lightbox"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pc-lightbox-title"
        >
          <FocusTrap autoFocus restoreFocus>
          {/* 🔴 THE MODAL OWNS ITS OWN CHROME, AND THAT IS THE WHOLE POINT.
              Player used to draw a white-on-media overlay carrying the back
              button, name and curator. In `classic` mode that DUPLICATED the
              themed toolbar above it, so it was removed (0.2.14) — but this
              dialog is `aria-modal` and COVERS that toolbar, so removing it
              here as well would leave the modal with no exit, no title and no
              accessible name.

              It deliberately reuses `toolbarStyle`/`titleStyle`/`subStyle` — the
              SAME objects the real toolbar uses — so the two surfaces cannot
              drift apart, and so this header is themed by construction rather
              than by a second set of colours somebody has to keep in sync. */}
          <div style={toolbarStyle()} data-testid="lightbox-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Button
                size="sm"
                variant="subtle"
                onClick={closeLightbox}
                data-testid="lightbox-exit"
                aria-label="Close the media viewer"
              >
                ←
              </Button>
              <div style={{ display: 'grid', minWidth: 0 }}>
                {/* Names the COLLECTION, matching the toolbar this stands in for
                    — not the individual item, which changes as the player
                    advances and would make the dialog's accessible name move
                    under the viewer. */}
                <span id="pc-lightbox-title" style={titleStyle} title={detail.name}>
                  {detail.name}
                </span>
                <span style={subStyle}>
                  {detail.curator.username ? `curated by ${detail.curator.username}` : 'curated collection'}
                </span>
              </div>
            </div>
          </div>
          {/* The SAME row as the normal surface, from the same function — the
              lightbox covers the outer one, so this is where it lives while the
              dialog is up, and there is still exactly one in the document. */}
          {viewerActionRow()}
          <Player
            items={displayItems}
            settings={settings}
            onSecondsPerImageChange={onSecondsPerImageChange}
            onVideoLoopCountChange={onVideoLoopCountChange}
            muted={prefs.muted}
            initialItemIndex={lightboxIndex}
            onCurrentItemChange={setLightboxItem}
            pickerOpen={pickerOpen}
            holdPaused={outstandingTip}
            isMobile={isMobile}
            c={c}
            onExit={closeLightbox}
          />
          </FocusTrap>
        </div>
      )}

      {/* ---- THE tip picker ---- */}
      {tipOpenFor && (
        <TipSplitModal
          // The FROZEN pair — never `liveCreator`/`liveCurator` again.
          creator={tipOpenFor.creator}
          curator={tipOpenFor.curator}
          balance={buzzBalance}
          submitting={tipping}
          dailyRemaining={dailyTipRemaining}
          // Each leg is one `ApiClient.tip` POST carrying the plan's key.
          onSendLeg={(target, amount, idempotencyKey) => onTip(target, amount, idempotencyKey)}
          onDone={onTipDone}
          onClose={() => setTipOpenFor(null)}
          plan={openTipPlan}
          onPlanChange={(plan) => {
            if (openTipKey != null) onSplitPlanChange(openTipKey, plan);
          }}
          onSendingChange={setTipSending}
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
