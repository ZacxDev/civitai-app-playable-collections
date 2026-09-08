// The full-page media player: stage + overlay chrome + transport controls.
// Mobile: swipe left/right + tap; Desktop: arrow keys + click zones. Auto-
// advances images (secondsPerImage) and loops videos (videoLoopCount) via
// usePlayer(). Overlay chrome: tip creator, tip curator, follow toggle. Tipped/
// followed state reflected optimistically. (A Buzz balance readout lived in the
// top overlay until 2026-09-05; `buzzBalance` is still a prop, but it is now
// spent only on TipModal's pre-validation, never rendered as chrome.)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Button, Loader, Slider } from '@civitai/blocks-react/ui';

import type { CollectionDetail, MediaItem } from '../types.js';
import { SECONDS_PER_IMAGE, VIDEO_LOOP_COUNT, type PlayerSettings } from '../settings.js';
import type { Palette } from '../theme.js';
import { usePlayer } from '../player/usePlayer.js';
import { useFollowToggle } from '../lib/follow.js';
import { filterToCeiling } from '../lib/maturity.js';
import { useViewerCeiling } from '../lib/viewer-maturity.js';
import { iconBtn } from './styles.js';
import { MaturityBadge } from './Maturity.js';
import { TipModal, type TipSender, type TipTarget } from './TipModal.js';
import { TipSplitModal, splitTipKey, type PlannedLeg, type SplitRecipient } from './TipSplitModal.js';
import type { TipLegKind } from '../lib/tip-split.js';

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
  /**
   * Adopt the HOST's echo after a confirmed follow write. Following runs through
   * the host bridge now (no `collections:write:self` scope), so there is no
   * app-side pending flag to pass in — `useFollowToggle` owns that window,
   * which includes the time the viewer spends in the host's consent dialog.
   */
  onFollowChange: (collectionId: number, followed: boolean) => void;
  /** Surface a renderable message (a real server error, or a timeout notice). */
  onNotice: (kind: 'success' | 'error' | 'info', message: string) => void;
  /**
   * A follow whose outcome is UNKNOWN (a transport timeout, or a code-less
   * server error raised after the row may already have committed) — drop cached
   * reads.
   *
   * 🔴 REQUIRED, NOT OPTIONAL, AND DELIBERATELY SO. While it was optional an
   * audit deleted the prop pass in App and BOTH forwards in CollectionViewer and
   * the whole suite stayed green — the app's own advice ("check the collection in
   * a moment") would then have been answered by the 5-minute read cache with the
   * PRE-follow flag, and nothing would have said so. Required makes that deletion
   * a compile error; `e2e-follow-uncertain.test.tsx` covers the behaviour.
   */
  onFollowUncertain: () => void;
  /** Perform one transfer. Resolves true on success (Player then marks it tipped). */
  onTip: TipSender;
  /**
   * Prompt a logged-out viewer to sign in. Tipping requires an account, so for an
   * anon viewer the tip triggers call this UP FRONT (before the amount picker)
   * instead of bouncing to sign-in only after amount selection.
   */
  onRequestSignIn?: () => void;
  tipping: boolean;
  /**
   * The viewer's REAL remaining daily tip allowance (server-read, 0.2.10).
   * Omitted while unresolved / after a failed read — the pickers then fall back
   * to the full cap rather than pre-blocking a tip the server would accept.
   */
  dailyTipRemaining?: number;
  /**
   * Split-tip plans in flight or half-failed, keyed by `splitTipKey`. Owned by
   * App so a plan OUTLIVES this component: closing the popover, switching view
   * mode, opening the lightbox and leaving the collection all unmount a Player,
   * and a plan that dies there takes its idempotency keys with it — after which
   * a re-confirm pays a landed leg a second time under a key the server has
   * never seen. See TipSplitModal's header.
   */
  splitPlans: Readonly<Record<string, PlannedLeg[]>>;
  /** Store (or, with `null`, retire) the plan for one logical tip. */
  onSplitPlanChange: (key: string, plan: PlannedLeg[] | null) => void;
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
    onFollowChange,
    onNotice,
    onFollowUncertain,
    onTip,
    onRequestSignIn,
    tipping,
    dailyTipRemaining,
    splitPlans,
    onSplitPlanChange,
    cast = false,
    reducedMotion = false,
    isMobile,
    c,
    onExit,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
  } = props;

  // The app's single follow action. Note it is NOT gated on `viewerUserId` here
  // the way tipping is: the host answers an anonymous follow with
  // `sign-in-required`, which routes into the same sign-in request, so gating
  // locally would only duplicate a decision the host already makes correctly.
  const follow = useFollowToggle({
    collectionId: detail.id,
    followed,
    onChange: onFollowChange,
    onSignInRequired: () => onRequestSignIn?.(),
    onNotice,
    onUncertain: onFollowUncertain,
  });

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

  const [tipTarget, setTipTarget] = useState<TipTarget | null>(null);
  // The %-split popover (operator feedback round 3). Separate from `tipTarget`:
  // that one is a single recipient, this one is a press that can produce TWO
  // transfers, so it has a plan + retry (see TipSplitModal).
  //
  // 🔴 IT HOLDS A SNAPSHOT OF BOTH RECIPIENTS, NOT A BOOLEAN — this is the whole
  // fix for the recipient drift. It used to be `splitOpen: boolean` with the
  // recipients derived LIVE from `current`, so the popover's targets changed
  // under the viewer whenever the media did: hold the popover open for one image
  // interval and the confirm paid the NEXT item's creator, against the NEXT
  // item's id, while the viewer had read a preview naming someone else. (If that
  // next creator happened to be the viewer, the creator leg went null and the
  // split silently collapsed into a curator-only tip carrying the whole total.)
  // `openTip` already snapshots into `tipTarget`, which is why the single-target
  // picker was never exposed; this matches that pattern rather than inventing a
  // second one.
  const [splitOpenFor, setSplitOpenFor] = useState<{ creator: SplitRecipient; curator: SplitRecipient } | null>(null);
  // Reported up by TipSplitModal: a leg is on the wire, so nothing may dismiss it.
  const [splitSending, setSplitSending] = useState(false);
  const [tippedKeys, setTippedKeys] = useState<Set<string>>(new Set());
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

  const creatorIsSelf = current != null && viewerUserId != null && current.creator.userId === viewerUserId;
  const curatorIsSelf = viewerUserId != null && detail.curator.userId === viewerUserId;
  const creatorTipped = current != null && tippedKeys.has(`Image:${current.mediaId}`);
  const curatorTipped = tippedKeys.has(`Collection:${detail.id}`);

  // ---- the two sides of a split, with the self-tip legs already collapsed ----
  // 🔴 `null` MEANS "THIS LEG DOES NOT EXIST", NOT "DISABLED". The server 403s a
  // self-tip, so offering the leg and letting it fail would take the viewer's
  // confirmation and then half-fail. `splitTipTotal` gives the whole total to
  // the surviving side, and the popover says why.
  const splitCreator: SplitRecipient =
    current != null && !creatorIsSelf
      ? {
          kind: 'creator',
          toUserId: current.creator.userId,
          username: current.creator.username,
          entityType: 'Image',
          entityId: current.mediaId,
        }
      : null;
  const splitCurator: SplitRecipient = curatorIsSelf
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
  //
  // 🔴 These two are the LIVE derivation, and from here on they are used ONLY to
  // decide whether the control is offered and what to freeze when it is pressed.
  // Nothing downstream of the press may read them again — that is the defect.
  const splitPossible = splitCreator != null || splitCurator != null;

  // The logical tip the open popover is for, and the plan App is holding for it.
  const openSplitKey = splitOpenFor ? splitTipKey(splitOpenFor.creator, splitOpenFor.curator) : null;
  const openSplitPlan = openSplitKey != null ? (splitPlans[openSplitKey] ?? null) : null;

  // ---- pause playback while ANY picker is open (defence in depth) ----
  // The snapshot above is what makes the money correct; this keeps the STAGE from
  // moving under a viewer who is reading a preview, which is the behaviour they
  // would expect anyway. Playback resumes only if it was running when the picker
  // opened, so this never starts a paused player.
  const pickerOpen = tipTarget != null || splitOpenFor != null;
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
      // A picker is open: Escape closes IT, and no shortcut reaches the player
      // underneath (Escape would otherwise exit the collection behind the modal).
      //
      // 🔴 EXCEPT WHILE A TRANSFER IS ON THE WIRE. This is a SECOND Escape
      // handler on top of `Modal`'s own, so gating the modal alone would leave
      // this one dismissing the popover mid-send — the Buzz still leaves the
      // account, and the partial-failure UI (with its retry) never appears.
      // `tipping` covers the single-target picker's in-flight window; the split
      // reports its own, because it stays open across two sequential legs.
      //
      // ⚠️ BOTH CLAUSES ARE KEPT, BUT ONLY ONE IS WITNESSED AT PRODUCTION
      // FIDELITY — recorded rather than glossed. In production `onSendLeg` routes
      // to `App.doTip`, which raises the SAME shared `tipping` flag for every leg,
      // so `splitSending` implies `tipping` and `!tipping` alone would already
      // refuse. The test that kills the `!splitSending` mutant does so from a
      // fixture (`trackTipping` off ⇒ `tipping:false, splitSending:true`) that
      // App cannot actually produce; a production-fidelity probe of the inter-leg
      // window did NOT kill it. That is one negative probe, not proof the clause
      // is redundant, so it stays — the cost is a boolean and the failure it
      // would allow is a mid-send dismissal that spends Buzz with no retry UI.
      // Do not cite it as tested.
      if (tipTarget || splitOpenFor) {
        if (e.key === 'Escape' && !splitSending && !tipping) {
          setTipTarget(null);
          setSplitOpenFor(null);
        }
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
  }, [player.next, player.prev, player.toggle, tipTarget, splitOpenFor, splitSending, tipping, onExit, cast]);

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
    // Logged-out: tipping needs an account, so prompt sign-in UP FRONT rather
    // than opening the amount picker and bouncing only after a selection.
    if (viewerUserId == null) {
      onRequestSignIn?.();
      return;
    }
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

  const openSplit = () => {
    // Same up-front sign-in bounce as the single-target pickers: tipping needs an
    // account, so ask before the amount picker rather than after a selection.
    if (viewerUserId == null) {
      onRequestSignIn?.();
      return;
    }
    if (!splitPossible) return;
    // 🔴 FREEZE BOTH SIDES HERE. Everything the popover sends, previews and
    // reports back is resolved from this snapshot, so the media underneath may
    // move (a timer, a filter, a reload) without redirecting a single Buzz.
    setSplitOpenFor({ creator: splitCreator, curator: splitCurator });
  };

  const closeSplit = () => setSplitOpenFor(null);

  /**
   * Every leg of a split landed — mark each recipient tipped, retire the plan
   * and close.
   *
   * 🔴 THE ✓ IS RESOLVED FROM THE SNAPSHOT, NOT FROM `current`. This read the
   * live `splitCreator`/`splitCurator` too, so a drifted popover marked "Tipped
   * creator" against whatever media was on screen at the moment the last leg
   * settled — the wrong media even when the transfer itself was right.
   */
  const onSplitDone = (legs: ReadonlyArray<{ kind: TipLegKind; amount: number }>) => {
    const frozen = splitOpenFor;
    setTippedKeys((prev) => {
      const next = new Set(prev);
      for (const leg of legs) {
        const target = leg.kind === 'creator' ? frozen?.creator : frozen?.curator;
        if (target) next.add(`${target.entityType}:${target.entityId}`);
      }
      return next;
    });
    // The logical tip is complete: its keys can never be needed again.
    if (openSplitKey != null) onSplitPlanChange(openSplitKey, null);
    setSplitOpenFor(null);
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
          media on the default `classic` playback surface. 🔴 `buzzBalance` remains
          a required prop: it is still passed to the creator/curator TipModal below
          for tip pre-validation. */}
      {chromeShown && (
        <div style={topBar(c)}>
          <button type="button" onClick={onExit} style={iconBtn(c)} aria-label="Back to collections" data-testid="player-exit">
            ←
          </button>
          <div style={titleWrap}>
            <span style={titleText}>{detail.name}</span>
            <span style={subText}>
              {detail.curator.username ? `curated by ${detail.curator.username}` : 'curated collection'}
            </span>
          </div>
        </div>
      )}

      {/* ---- right overlay chrome: tip/follow ---- */}
      {chromeShown && (
        <div style={rightRail} data-testid="overlay-chrome">
          <ChromeButton
            c={c}
            glyph={creatorTipped ? '✓' : '💸'}
            label={creatorTipped ? 'Tipped creator' : 'Tip creator'}
            disabled={!current || creatorIsSelf || tipping}
            active={creatorTipped}
            onClick={() => openTip('creator')}
            testid="tip-creator"
            // Explain why the control is disabled for your own media (#5).
            title={creatorIsSelf ? "You can't tip your own media." : undefined}
          />
          <ChromeButton
            c={c}
            glyph={curatorTipped ? '✓' : '🎁'}
            label={curatorTipped ? 'Tipped curator' : 'Tip curator'}
            disabled={curatorIsSelf || tipping}
            active={curatorTipped}
            onClick={() => openTip('curator')}
            testid="tip-curator"
            title={curatorIsSelf ? "You can't tip your own collection." : undefined}
          />
          {/* The split press. It sits BETWEEN the two single-target tips it
              combines, so the rail reads creator → both → curator. Disabled only
              when there is genuinely nobody to pay (the viewer owns the media AND
              the collection); a single collapsed side still opens, and gives the
              whole total to the side that survives. */}
          <ChromeButton
            c={c}
            glyph="🤝"
            label="Split tip"
            disabled={!splitPossible || tipping}
            active={false}
            onClick={openSplit}
            testid="tip-split"
            title={!splitPossible ? "This is your own media in your own collection — there's no one to tip." : undefined}
          />
          <ChromeButton
            c={c}
            glyph={followed ? '★' : '☆'}
            label={followed ? 'Following' : 'Follow collection'}
            disabled={follow.pending}
            active={followed}
            onClick={follow.toggle}
            testid="follow-toggle"
          />
        </div>
      )}

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

      {tipTarget && (
        <TipModal
          target={tipTarget}
          balance={buzzBalance}
          submitting={tipping}
          dailyRemaining={dailyTipRemaining}
          onConfirm={confirmTip}
          onClose={() => setTipTarget(null)}
        />
      )}

      {splitOpenFor && (
        <TipSplitModal
          // The FROZEN pair — never `splitCreator`/`splitCurator` again.
          creator={splitOpenFor.creator}
          curator={splitOpenFor.curator}
          balance={buzzBalance}
          submitting={tipping}
          dailyRemaining={dailyTipRemaining}
          // Each leg is one `ApiClient.tip` POST carrying the plan's key.
          onSendLeg={(target, amount, idempotencyKey) => onTip(target, amount, idempotencyKey)}
          onDone={onSplitDone}
          onClose={closeSplit}
          plan={openSplitPlan}
          onPlanChange={(plan) => {
            if (openSplitKey != null) onSplitPlanChange(openSplitKey, plan);
          }}
          onSendingChange={setSplitSending}
        />
      )}
    </div>
  );
}

function ChromeButton({
  c,
  glyph,
  label,
  disabled,
  active,
  onClick,
  testid,
  title,
}: {
  c: Palette;
  glyph: string;
  label: string;
  disabled: boolean;
  active: boolean;
  onClick: () => void;
  testid: string;
  /** Native tooltip — used to explain a disabled state (e.g. self-tip). */
  title?: string;
}) {
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 2 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        style={iconBtn(c, active, disabled)}
        aria-label={title ?? label}
        aria-pressed={active}
        title={title}
        data-testid={testid}
      >
        {glyph}
      </button>
      <span style={{ fontSize: 10, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
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
  color: '#fff',
  fontWeight: 700,
  fontSize: 15,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textShadow: '0 1px 3px rgba(0,0,0,0.8)',
};
const subText: CSSProperties = { color: 'rgba(255,255,255,0.8)', fontSize: 12, textShadow: '0 1px 3px rgba(0,0,0,0.8)' };

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
