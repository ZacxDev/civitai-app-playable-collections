// 🔴 THE ONE TIP AFFORDANCE — the money surface, tested where it now lives.
//
// T5 collapsed four presses into one. `Player` used to draw an `overlay-chrome`
// right rail carrying `tip-creator`, `tip-curator`, `tip-split` and
// `follow-toggle`; the continuous modes had a separate row with a curator tip
// alone. A Player exists on only one of the three surfaces, so that arrangement
// made "the same actions everywhere" impossible by construction — a viewer could
// not tip a creator, or split a tip, from Ticker or Wall at all.
//
// This file is the successor to the split-popover sections of the old
// `Player.test.tsx`. Every case there came across with its fixtures and its
// assertions; what changed is the component the press goes through. It adds the
// cases the consolidation newly makes possible to state:
//   - EXACTLY ONE tip affordance, in every mode and with the lightbox open,
//   - all three destinations reachable from it, in every mode,
//   - the press-time snapshot surviving the media being replaced underneath,
//   - the plan surviving a MODE SWITCH and a lightbox open/close.
//
// The host below mirrors `App`: it OWNS the split plans, because a constant
// `splitPlans={{}}` would make the partial-failure panel unreachable and quietly
// hollow out every retry assertion here.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CollectionViewer, type CollectionViewerProps } from './CollectionViewer.js';
import { flushIntersections } from '../test-setup.js';
import { palette } from '../theme.js';
import type { TipTarget } from '../lib/tip-target.js';
import type { CollectionDetail, MediaItem } from '../types.js';

const c = palette();

const VIEWER = 99;
const BOB = 22;
const CAROL = 33;
const CURATOR = 11;

function img(mediaId: number, userId: number, username: string): MediaItem {
  return {
    mediaId,
    type: 'image',
    url: `https://x.invalid/i/${mediaId}.jpg`,
    width: 10,
    height: 10,
    creator: { userId, username },
    nsfwLevel: 1,
  };
}

const detail: CollectionDetail = {
  id: 501,
  name: 'Drift',
  description: null,
  curator: { userId: CURATOR, username: 'alice' },
  isPublic: true,
  followed: false,
};

const byBob = img(1001, BOB, 'bob');
const byCarol = img(1002, CAROL, 'carol');
/**
 * A SECOND image by the SAME creator, in the same collection.
 *
 * 🔴 THIS IS THE FIXTURE THE PLAN-KEY HAZARD NEEDS. Two items with different
 * creators are separated by the `toUserId` in `splitTipKey` alone, so a key
 * reduced to just the people still tells them apart — a test built on
 * bob-then-carol survives that mutant. Same creator, different entity is the
 * pair that only an entity-aware key can distinguish.
 */
const alsoByBob = img(1002, BOB, 'bob');

type TipMock = ReturnType<typeof makeTip>;
function makeTip() {
  return vi.fn(async (_target: TipTarget, _amount: number, _idempotencyKey?: string) => true);
}

/** Fresh in-memory Storage so per-collection mode/position restore is isolated. */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

function Host({
  items,
  onTip,
  viewerUserId = VIEWER,
  dailyTipRemaining,
  storage,
  reducedMotion = true,
  hasTipScope,
  onRequestTipConsent,
  onRequestSignIn,
}: {
  items: MediaItem[];
  onTip: TipMock;
  viewerUserId?: number | null;
  dailyTipRemaining?: number;
  storage?: Storage;
  /**
   * 🔴 DEFAULTS TO `true`, AND ANY AUTO-SCROLL ASSERTION MUST TURN IT OFF.
   * `shouldAutoScroll(reducedMotion, paused)` is already `off` under reduced
   * motion, so a test that asserts "the wall is not scrolling" with the default
   * fixture passes whether or not the code under test does anything at all.
   */
  reducedMotion?: boolean;
  /** See the consent block at the foot of this file. Defaults to "granted". */
  hasTipScope?: boolean;
  onRequestTipConsent?: () => void;
  onRequestSignIn?: () => void;
}) {
  const [splitPlans, setSplitPlans] = useState<CollectionViewerProps['splitPlans']>({});
  const props: CollectionViewerProps = {
    detail,
    items,
    settings: { secondsPerImage: 5, videoLoopCount: 1 },
    onSecondsPerImageChange: () => {},
    onVideoLoopCountChange: () => {},
    viewerUserId,
    buzzBalance: 5000,
    followed: false,
    onFollowChange: () => {},
    onTip,
    tipping: false,
    dailyTipRemaining,
    splitPlans,
    onSplitPlanChange: (key, plan) =>
      setSplitPlans((prev) => {
        if (plan == null) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: plan };
      }),
    isMobile: false,
    c,
    onExit: () => {},
    storage: storage ?? memStorage(),
    reducedMotion,
    hasTipScope,
    onRequestTipConsent,
    onRequestSignIn,
  };
  return <CollectionViewer {...props} />;
}

/**
 * Refuse the curator leg exactly once, then accept it — the half-failed plan every
 * outstanding-tip case is built on. Module scope, because both the C6 block and
 * the continuous-surface block need it.
 */
function curatorRefusedOnce(): TipMock {
  let attempts = 0;
  return vi.fn(async (target: TipTarget, _amount: number, _idempotencyKey?: string) => {
    if (target.kind === 'curator' && ++attempts === 1) return false;
    return true;
  });
}

/** Switch to a view mode through the real ModeSwitcher. */
async function switchTo(mode: 'classic' | 'continuous-horizontal' | 'continuous-vertical') {
  await userEvent.click(screen.getByTestId(`mode-switcher-${mode}`));
}

async function openPicker() {
  await userEvent.click(screen.getByTestId('chrome-tip'));
  return screen.findByTestId('tip-split-modal');
}

// ===========================================================================
// C1 — exactly ONE tip affordance, present on every surface
// ===========================================================================

describe('🔴 exactly ONE tip affordance, and it exists in Slideshow, Ticker and Wall', () => {
  /**
   * 🔴 `getAllByTestId(...).length === 1`, NOT `getByTestId(...)`.
   * `getByTestId` THROWS on more than one match, which reads like a broken query
   * rather than a duplicated money button — and the failure message would name
   * the query, not the criterion. Counting says what is actually being claimed.
   */
  const countTip = () => screen.getAllByTestId('chrome-tip').length;
  const countFollow = () => screen.getAllByTestId('chrome-follow').length;

  it('classic / ticker / wall each show exactly one tip and one follow', async () => {
    render(<Host items={[byBob, byCarol]} onTip={makeTip()} />);

    expect(screen.getByTestId('collection-viewer')).toHaveAttribute('data-mode', 'classic');
    expect(countTip()).toBe(1);
    expect(countFollow()).toBe(1);

    await switchTo('continuous-horizontal');
    expect(screen.getByTestId('collection-viewer')).toHaveAttribute('data-mode', 'continuous-horizontal');
    expect(countTip()).toBe(1);
    expect(countFollow()).toBe(1);

    await switchTo('continuous-vertical');
    expect(screen.getByTestId('collection-viewer')).toHaveAttribute('data-mode', 'continuous-vertical');
    expect(countTip()).toBe(1);
    expect(countFollow()).toBe(1);
  });

  it('🔴 the LIGHTBOX carries the row rather than adding a second one', async () => {
    // The lightbox is `aria-modal` and COVERS the surface row, so it must render
    // the actions itself — and the covered row must not still be in the document,
    // or "one affordance" is false while the screen looks right.
    render(<Host items={[byBob, byCarol]} onTip={makeTip()} />);
    await switchTo('continuous-vertical');
    await userEvent.click(screen.getAllByTestId('continuous-tile')[0]);
    const lightbox = await screen.findByTestId('lightbox');

    expect(countTip()).toBe(1);
    expect(countFollow()).toBe(1);
    expect(within(lightbox).getByTestId('chrome-tip')).toBeInTheDocument();
    expect(within(lightbox).getByTestId('chrome-follow')).toBeInTheDocument();

    await userEvent.click(within(lightbox).getByTestId('lightbox-exit'));
    await waitFor(() => expect(screen.queryByTestId('lightbox')).toBeNull());
    expect(countTip()).toBe(1);
  });

  it('🔴 none of the four retired presses exist on any surface', async () => {
    // An INVARIANT GUARD, not regression coverage: it pins the deletion so a
    // later change cannot quietly re-add a second tip route beside the one above.
    render(<Host items={[byBob, byCarol]} onTip={makeTip()} />);
    for (const mode of ['classic', 'continuous-horizontal', 'continuous-vertical'] as const) {
      await switchTo(mode);
      for (const gone of ['tip-creator', 'tip-curator', 'tip-split', 'follow-toggle', 'chrome-tip-curator', 'overlay-chrome']) {
        expect(screen.queryByTestId(gone)).toBeNull();
      }
    }
  });
});

// ===========================================================================
// C2 — all three destinations reachable from that one affordance
// ===========================================================================

describe('🔴 creator, curator AND a split are all reachable from the one control', () => {
  it.each(['classic', 'continuous-horizontal', 'continuous-vertical'] as const)(
    'in %s: Creator sends one leg to the creator of the media on screen',
    async (mode) => {
      const onTip = makeTip();
      render(<Host items={[byBob, byCarol]} onTip={onTip} />);
      await switchTo(mode);
      const modal = await openPicker();

      await userEvent.click(within(modal).getByTestId('tip-target-creator'));
      expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 50 Buzz');
      expect(screen.queryByTestId('split-preview-curator')).toBeNull();

      await userEvent.click(within(modal).getByTestId('split-confirm'));
      await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));
      expect(onTip.mock.calls[0][0]).toMatchObject({
        kind: 'creator',
        toUserId: BOB,
        entityType: 'Image',
        entityId: 1001,
      });
      expect(onTip.mock.calls[0][1]).toBe(50);
    },
  );

  it.each(['classic', 'continuous-horizontal', 'continuous-vertical'] as const)(
    'in %s: Curator sends one leg to the collection curator',
    async (mode) => {
      const onTip = makeTip();
      render(<Host items={[byBob, byCarol]} onTip={onTip} />);
      await switchTo(mode);
      const modal = await openPicker();

      await userEvent.click(within(modal).getByTestId('tip-target-curator'));
      expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 50 Buzz');
      expect(screen.queryByTestId('split-preview-creator')).toBeNull();

      await userEvent.click(within(modal).getByTestId('split-confirm'));
      await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));
      expect(onTip.mock.calls[0][0]).toMatchObject({
        kind: 'curator',
        toUserId: CURATOR,
        entityType: 'Collection',
        entityId: 501,
      });
      expect(onTip.mock.calls[0][1]).toBe(50);
    },
  );

  it.each(['classic', 'continuous-horizontal', 'continuous-vertical'] as const)(
    'in %s: Split sends TWO legs, one to each',
    async (mode) => {
      const onTip = makeTip();
      render(<Host items={[byBob, byCarol]} onTip={onTip} />);
      await switchTo(mode);
      const modal = await openPicker();

      // Split is the default; press it anyway so the case exercises the control
      // rather than the initial state.
      await userEvent.click(within(modal).getByTestId('tip-target-split'));
      await userEvent.click(within(modal).getByTestId('split-confirm'));
      await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));
      expect(onTip.mock.calls[0][0]).toMatchObject({ kind: 'creator', toUserId: BOB });
      expect(onTip.mock.calls[1][0]).toMatchObject({ kind: 'curator', toUserId: CURATOR });
      expect(onTip.mock.calls[0][1] + onTip.mock.calls[1][1]).toBe(50);
    },
  );
});

// ===========================================================================
// The LIGHTBOX money path — the seam the affordance-count tests do not reach
// ===========================================================================

describe('🔴 tipping from INSIDE the lightbox', () => {
  // 🔴 COUNTING THE BUTTON IS NOT EXERCISING IT. Until these cases existed, every
  // lightbox test in the repo opened the dialog, asserted `chrome-tip` was there,
  // and closed it — so the two props that make the lightbox's money correct had no
  // witness at all, and both survived as mutants against the whole suite:
  //   * `onCurrentItemChange={setLightboxItem}` → `setSurfaceItem` — `lightboxItem`
  //     then stays null, the creator side collapses, and the picker tells a viewer
  //     who does NOT own the media "This is your media, so the whole tip goes to
  //     the collection curator" while sending the curator the entire total.
  //   * `pickerOpen={pickerOpen}` → `false` — the lightbox Player keeps advancing
  //     under an open picker AND its window-level Escape closes the whole lightbox
  //     on the keystroke that dismisses the dialog.

  async function openLightboxOn(tileIndex: number) {
    await switchTo('continuous-vertical');
    await userEvent.click(screen.getAllByTestId('continuous-tile')[tileIndex]);
    return screen.findByTestId('lightbox');
  }

  it('pays the creator of the TAPPED tile, not the wall\'s first item', async () => {
    // The discriminator is the tile INDEX: tapping the second tile must name
    // carol, while everything that reads the surface slot still names bob.
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const lightbox = await openLightboxOn(1);
    expect(within(lightbox).getByTestId('progress-label')).toHaveTextContent('2 / 2');

    await userEvent.click(within(lightbox).getByTestId('chrome-tip'));
    const modal = await screen.findByTestId('tip-split-modal');
    await userEvent.click(within(modal).getByTestId('tip-target-creator'));
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@carol (creator): 50 Buzz');

    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));
    expect(onTip.mock.calls[0][0]).toMatchObject({
      kind: 'creator',
      toUserId: CAROL,
      entityType: 'Image',
      entityId: 1002,
    });
  });

  it('the FIRST lightbox of a session opens with both sides present (POSITIVE CONTROL)', async () => {
    // ⚠️ LABELLED HONESTLY: THIS IS A POSITIVE CONTROL, NOT REGRESSION COVERAGE.
    // `lightboxItem` starts null and is filled by the newly-mounted Player's
    // LAYOUT effect, so by the time testing-library hands control back the slot is
    // already correct — and it would be under a passive effect too, because
    // `act()` flushes those before `render()` returns. So this case cannot fail
    // for the ordering defect its earlier name claimed ("no null window"), and an
    // earlier version of this comment credited a `setLightboxItem` seed in
    // `openLightbox` that does not exist and must not be re-added.
    //
    // What it IS worth: it proves the dialog's first paint offers BOTH sides, so
    // the surrounding cases are not passing over a picker that silently collapsed.
    // The ordering property itself is pinned by the two `reports WITHIN THE COMMIT`
    // probes in Player.test.tsx / ContinuousView.test.tsx.
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const lightbox = await openLightboxOn(0);
    await userEvent.click(within(lightbox).getByTestId('chrome-tip'));
    const modal = await screen.findByTestId('tip-split-modal');
    // Both sides present ⇒ the creator side did not collapse.
    expect(within(modal).getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator)');
    expect(within(modal).getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator)');
    expect(modal).not.toHaveTextContent('This is your media');
  });

  it('pauses the LIGHTBOX transport while the picker is open, and Escape does not close the dialog', async () => {
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const lightbox = await openLightboxOn(0);
    expect(within(lightbox).getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(lightbox).getByTestId('chrome-tip'));
    await screen.findByTestId('tip-split-modal');
    expect(within(lightbox).getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false');

    // 🔴 One Escape dismisses the PICKER and leaves the dialog standing. Without
    // the gate the lightbox Player's own window handler runs too and calls
    // `onExit()`, tearing the dialog down on the same keystroke.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());
    expect(screen.getByTestId('lightbox')).toBeInTheDocument();
  });

  it('closing the lightbox hands the tip target back to the surface underneath', async () => {
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const lightbox = await openLightboxOn(1);
    await userEvent.click(within(lightbox).getByTestId('lightbox-exit'));
    await waitFor(() => expect(screen.queryByTestId('lightbox')).toBeNull());

    // Back on the wall, the target is the wall's item again — not the tile the
    // dialog was showing a moment ago.
    await userEvent.click(screen.getByTestId('chrome-tip'));
    const modal = await screen.findByTestId('tip-split-modal');
    await userEvent.click(within(modal).getByTestId('tip-target-creator'));
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator)');
  });
});

// ===========================================================================
// C5 — the press-time snapshot
// ===========================================================================

describe('🔴 the picker freezes its recipients at press time, not at confirm', () => {
  it('keeps paying the creator it previewed even when the media underneath is replaced', async () => {
    // 🔴 REPLACING `items` IS A PATH NO PAUSE CAN INTERCEPT. Pausing playback is
    // defence in depth; the recipients must be pinned at press time regardless of
    // WHY the media moved (a filter, a shuffle, a reload, a page append).
    const onTip = makeTip();
    const { rerender } = render(<Host items={[byBob, byCarol]} onTip={onTip} />);

    await openPicker();
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');

    rerender(<Host items={[byCarol, byBob]} onTip={onTip} />);
    // The stage really did move …
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', byCarol.url);
    // … and the picker really did not.
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');

    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));

    expect(onTip.mock.calls[0][0]).toMatchObject({
      kind: 'creator',
      toUserId: BOB,
      entityType: 'Image',
      entityId: 1001,
    });
    expect(onTip.mock.calls[0][1]).toBe(25);
    expect(onTip.mock.calls[1][0]).toMatchObject({
      kind: 'curator',
      toUserId: CURATOR,
      entityType: 'Collection',
      entityId: 501,
    });
  });

  it('🔴 the same freeze holds on the WALL, where the surface has no transport at all', async () => {
    const onTip = makeTip();
    const { rerender } = render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    await switchTo('continuous-vertical');
    await openPicker();
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');

    rerender(<Host items={[byCarol, byBob]} onTip={onTip} />);
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');

    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));
    expect(onTip.mock.calls[0][0]).toMatchObject({ toUserId: BOB, entityId: 1001 });
  });

  it('pauses the classic transport while the picker is open, and resumes on close', async () => {
    render(<Host items={[byBob, byCarol]} onTip={makeTip()} />);
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'true');

    const modal = await openPicker();
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(within(modal).getByTestId('split-cancel'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'true');
  });
});

// ===========================================================================
// Ticker / Wall — the surfaces the drift hazard is WORST on
// ===========================================================================

describe('🔴 the continuous surfaces, with the observer actually speaking', () => {
  // 🔴 EVERY OTHER Ticker/Wall CASE IN THIS FILE RESOLVES THE CREATOR THROUGH THE
  // FALLBACK ARM. `currentItem` is `items.find(in view) ?? items[0]`, and nothing
  // else here fires an intersection, so `inViewIds` is empty and the suite
  // exercises an arm a real browser never takes. These fire a PARTIAL
  // intersection — the only shape where "first in view" and "first item" are
  // different elements — so the branch production always takes carries the money
  // assertion for once.

  it('tips the creator of the tile the viewer can actually SEE', async () => {
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    await switchTo('continuous-vertical');

    // Tile 0 is scrolled off; tile 1 is in view.
    await act(async () => {
      flushIntersections(true, (_el, i) => i !== 0);
    });

    const modal = await openPicker();
    await userEvent.click(within(modal).getByTestId('tip-target-creator'));
    // 🔴 carol, not bob. Through the fallback this reads bob and the test is
    // indistinguishable from one that never fired an intersection at all.
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@carol (creator)');

    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));
    expect(onTip.mock.calls[0][0]).toMatchObject({ toUserId: CAROL, entityId: 1002 });
  });

  it('🔴 the Pause control reports the state it is actually in, and says why it is stuck', async () => {
    // 🔴 A CONTROL THAT MISREPORTS THE THING IT CONTROLS IS WORSE THAN A DISABLED
    // ONE. The button rendered from the LOCAL `paused` flag alone, so while the
    // outstanding-tip hold had the wall stopped it sat there reading "⏸ Pause"
    // over an already-still surface — and pressing it did nothing, twice, with no
    // explanation anywhere on screen. The viewer's reasonable conclusion is that
    // the app is broken, at the exact moment they have Buzz half-sent.
    const onTip = curatorRefusedOnce();
    render(<Host items={[byBob, byCarol]} onTip={onTip} reducedMotion={false} />);
    await switchTo('continuous-vertical');

    // Control: before any tip it is a live, unpressed Pause.
    const before = screen.getByTestId('toggle-pause');
    expect(before).toHaveTextContent('Pause');
    expect(before).toHaveAttribute('aria-pressed', 'false');
    expect(before).not.toBeDisabled();

    const modal = await openPicker();
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    await userEvent.click(screen.getByTestId('split-cancel'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    const held = screen.getByTestId('toggle-pause');
    expect(held).toHaveTextContent('Resume');
    expect(held).toHaveAttribute('aria-pressed', 'true');
    expect(held).toBeDisabled();
    expect(held).toHaveAttribute(
      'title',
      'Paused while part of your tip is still unsent — retry it, or start a new tip.',
    );

    // Settling the tip hands the control back.
    const reopened = await openPicker();
    await userEvent.click(within(reopened).getByTestId('split-retry'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('toggle-pause')).not.toBeDisabled());
    expect(screen.getByTestId('toggle-pause')).toHaveTextContent('Pause');
  });

  it('🔴 the WALL stops drifting while a tip is outstanding, and starts again when it is settled', async () => {
    // 🔴 `reducedMotion: false` IS LOAD-BEARING. Under the fixture default,
    // `shouldAutoScroll` is already false and this assertion would hold with the
    // whole hold deleted — the vacuous-by-config shape.
    const onTip = curatorRefusedOnce();
    render(<Host items={[byBob, byCarol]} onTip={onTip} reducedMotion={false} />);
    await switchTo('continuous-vertical');
    const view = screen.getByTestId('continuous-view');
    expect(view).toHaveAttribute('data-autoscroll', 'on'); // control: it really does drift

    const modal = await openPicker();
    expect(screen.getByTestId('continuous-view')).toHaveAttribute('data-autoscroll', 'off');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    await userEvent.click(screen.getByTestId('split-cancel'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    // 🔴 THE POINT: the picker is CLOSED and the wall is still still. This surface
    // needs no viewer action to drift, so releasing here would move the media —
    // and the key with it — with the curator leg still outstanding.
    expect(screen.getByTestId('continuous-view')).toHaveAttribute('data-autoscroll', 'off');

    // Settle the tip; the wall is released.
    const reopened = await openPicker();
    await userEvent.click(within(reopened).getByTestId('split-retry'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId('continuous-view')).toHaveAttribute('data-autoscroll', 'on'),
    );
  });
});

// ===========================================================================
// C6 — the plan outlives everything that unmounts a surface
// ===========================================================================

describe('🔴 a half-failed plan survives the four things that unmount a surface', () => {
  async function halfFail(onTip: TipMock, storage: Storage) {
    render(<Host items={[byBob, byCarol]} onTip={onTip} storage={storage} />);
    const modal = await openPicker();
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    expect(screen.getByTestId('split-leg-curator')).toHaveAttribute('data-status', 'failed');
  }

  it('dismiss → reopen resumes the SAME plan, landed leg still marked sent', async () => {
    const onTip = curatorRefusedOnce();
    await halfFail(onTip, memStorage());
    await userEvent.click(screen.getByTestId('split-cancel')); // labelled "Close"
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    const reopened = await openPicker();
    expect(await within(reopened).findByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    expect(within(reopened).getByTestId('split-retry')).toBeInTheDocument();
  });

  it('🔴 SWITCHING VIEW MODE does not destroy the plan or its keys', async () => {
    const onTip = curatorRefusedOnce();
    await halfFail(onTip, memStorage());
    const creatorKey = onTip.mock.calls[0][2];
    await userEvent.click(screen.getByTestId('split-cancel'));

    // classic → wall → classic. Each switch unmounts a whole mode surface.
    await switchTo('continuous-vertical');
    await switchTo('classic');

    const reopened = await openPicker();
    expect(await within(reopened).findByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    await userEvent.click(within(reopened).getByTestId('split-retry'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    // 🔴 THE INVARIANT: THREE calls for one logical tip (creator, curator-refused,
    // curator-retried) — not four. A plan that died on the mode switch would mint
    // a fresh creator key and pay bob a second time.
    expect(onTip).toHaveBeenCalledTimes(3);
    expect(onTip.mock.calls.filter((call) => call[0].kind === 'creator')).toHaveLength(1);
    expect(onTip.mock.calls[0][2]).toBe(creatorKey);
  });

  it('🔴 OPENING AND CLOSING THE LIGHTBOX does not destroy the plan or its keys', async () => {
    const onTip = curatorRefusedOnce();
    await halfFail(onTip, memStorage());
    const creatorKey = onTip.mock.calls[0][2];
    await userEvent.click(screen.getByTestId('split-cancel'));

    await switchTo('continuous-vertical');
    await userEvent.click(screen.getAllByTestId('continuous-tile')[0]);
    const lightbox = await screen.findByTestId('lightbox');
    await userEvent.click(within(lightbox).getByTestId('lightbox-exit'));
    await waitFor(() => expect(screen.queryByTestId('lightbox')).toBeNull());
    await switchTo('classic');

    const reopened = await openPicker();
    expect(await within(reopened).findByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    await userEvent.click(within(reopened).getByTestId('split-retry'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    expect(onTip).toHaveBeenCalledTimes(3);
    expect(onTip.mock.calls.filter((call) => call[0].kind === 'creator')).toHaveLength(1);
    expect(onTip.mock.calls[0][2]).toBe(creatorKey);
  });

  it('🔴 the plan KEY is frozen too — replacing the media under a half-failed plan cannot orphan it', async () => {
    // 🔴 THE SNAPSHOT HAS TWO CONSUMERS AND THIS IS THE SECOND ONE. The recipients
    // handed to the picker are frozen (covered above); so is the key the plan is
    // stored and resumed under, and that half had no witness until this case —
    // a mutant reading `splitTipKey(liveCreator, liveCurator)` instead of the
    // frozen pair passed the whole suite.
    //
    // What that mutant does to a viewer: the creator leg has landed, the curator
    // leg has not, and the media underneath is replaced (a filter, a shuffle, a
    // page append — none of which the picker's pause can stop). The key moves, so
    // `splitPlans[key]` misses, so `plan` goes null: the partial-failure panel and
    // its Retry vanish and are replaced by a fresh Send. Pressing it mints NEW
    // idempotency keys the server has never seen, and pays the creator a SECOND
    // time for one press. That is the 0.2.10 defect exactly, re-entering through
    // the key rather than through the recipients.
    const onTip = curatorRefusedOnce();
    const { rerender } = render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const modal = await openPicker();
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    const creatorKey = onTip.mock.calls[0][2];

    // The media moves under the OPEN picker, plan and all.
    rerender(<Host items={[byCarol, byBob]} onTip={onTip} />);
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', byCarol.url);

    // The plan is still THIS tip's plan: the panel, the landed leg and the Retry
    // are all still there — not a blank picker offering a fresh Send.
    expect(screen.getByTestId('split-partial')).toBeInTheDocument();
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    const retry = screen.getByTestId('split-retry');

    await userEvent.click(retry);
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    // 🔴 THREE calls for one press — creator, curator-refused, curator-retried —
    // and the creator's original key. A drifted key lands here as FOUR, with a
    // second creator transfer under a key the server cannot collapse.
    expect(onTip).toHaveBeenCalledTimes(3);
    expect(onTip.mock.calls.filter((call) => call[0].kind === 'creator')).toHaveLength(1);
    expect(onTip.mock.calls[0][2]).toBe(creatorKey);
    // …and it is still bob who was paid, not the creator who drifted into view.
    expect(onTip.mock.calls[0][0]).toMatchObject({ toUserId: BOB, entityId: 1001 });
  });

  it('🔴 REOPENING the picker while the hold is already on still pauses the transport', async () => {
    // 🔴 THE DEP-ARRAY HOLE, AND IT HAD NO WITNESS. The pause effect keyed on the
    // MERGED hold flag, so `pickerOpen` going false→true while the outstanding-tip
    // hold was already on was not a dep change and `pause()` never ran. Reachable
    // in three ordinary presses, and it is exactly the "advances under an open
    // picker" defect the lightbox tests kill in their own context.
    const onTip = curatorRefusedOnce();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const modal = await openPicker();
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    await userEvent.click(screen.getByTestId('split-cancel'));
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false');

    // The viewer restarts playback themselves — explicitly allowed while held.
    await userEvent.click(screen.getByTestId('ctrl-play'));
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'true');

    // …then reopens the picker to retry. The transport must stop again.
    await openPicker();
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false');
  });

  it('🔴 does NOT restart playback the viewer deliberately stopped during a hold', async () => {
    // The mirror of the case above. The outstanding-tip hold spans the viewer's own
    // presses, so a resume decision captured when the hold BEGAN is stale by the
    // time it ends — acting on it restarts playback for someone who paused it.
    const onTip = curatorRefusedOnce();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const modal = await openPicker();
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    await userEvent.click(screen.getByTestId('split-cancel'));

    // Play, then deliberately pause again, while the hold is on.
    await userEvent.click(screen.getByTestId('ctrl-play'));
    await userEvent.click(screen.getByTestId('ctrl-play'));
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false');

    // Settle the tip — the hold releases, and must NOT hand playback back.
    const reopened = await openPicker();
    await userEvent.click(within(reopened).getByTestId('split-retry'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false');
  });

  it('🔴 the media does not DRIFT AWAY from an outstanding plan on its own', async () => {
    // 🔴 THE PICKER PROMISES THIS IN SO MANY WORDS: "Closing is safe too:
    // reopening this split picks the same tip back up, for as long as this page
    // stays open." The plan is keyed to the MEDIA, so that promise holds only
    // while the media stays put — and closing the picker used to RESUME the
    // transport, so five seconds of doing nothing moved the key, orphaned the
    // outstanding curator leg, and handed the viewer a blank Send. Confirming
    // that mints a FRESH idempotency key for a transfer whose predecessor may
    // already have landed. On Ticker and Wall it is worse: they auto-scroll, so
    // the drift needs no viewer action at all.
    //
    // The fix is not to re-point the key — a different image genuinely IS a
    // different tip (the case below depends on that). It is that the app must not
    // START MOTION BY ITSELF while a tip is outstanding. The viewer can still
    // press Play, or navigate; that is a choice, and it forfeits the plan visibly.
    const onTip = curatorRefusedOnce();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const modal = await openPicker();
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');

    // The viewer presses Close — the button this very state relabels, right beside
    // the promise quoted above.
    await userEvent.click(screen.getByTestId('split-cancel'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    // 🔴 THE ASSERTION. The transport must NOT be running: there is money
    // outstanding on the item it would advance away from.
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');

    // …and the plan is therefore still reachable, exactly as the copy says.
    const reopened = await openPicker();
    expect(await within(reopened).findByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    expect(within(reopened).getByTestId('split-retry')).toBeInTheDocument();
  });

  it('does not carry a half-failed plan across to a different image BY THE SAME CREATOR', async () => {
    // 🔴 BOTH ITEMS ARE BY BOB, AND THAT IS THE POINT. The pair the title names
    // is the pair a key of `${toUserId}` alone cannot separate; a bob-then-carol
    // fixture passes with the entity dropped from the key and proves nothing.
    const onTip: TipMock = vi.fn(
      async (target: TipTarget, _amount: number, _idempotencyKey?: string) => target.kind !== 'curator',
    );
    render(<Host items={[byBob, alsoByBob]} onTip={onTip} />);

    await openPicker();
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    await userEvent.click(screen.getByTestId('split-cancel'));

    await userEvent.click(screen.getByTestId('ctrl-next'));
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2');
    const second = await openPicker();

    // A brand-new tip: no partial-failure panel, a live Send, nothing locked.
    expect(within(second).queryByTestId('split-partial')).toBeNull();
    expect(within(second).getByTestId('split-confirm')).not.toBeDisabled();
    expect(within(second).getByTestId('split-amount-input')).not.toBeDisabled();

    // …while bob's FIRST plan is untouched: going back resumes it.
    await userEvent.click(within(second).getByTestId('split-cancel'));
    await userEvent.click(screen.getByTestId('ctrl-prev'));
    await openPicker();
    expect(await screen.findByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
  });

  it('🔴 a COMPLETED tip RETIRES its plan — reopening gives a usable picker, not a dead Send', async () => {
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    await openPicker();
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    const reopened = await openPicker();
    expect(within(reopened).queryByTestId('split-partial')).toBeNull();
    expect(within(reopened).getByTestId('split-amount-input')).not.toBeDisabled();
    expect(within(reopened).getByTestId('split-confirm')).not.toBeDisabled();

    const input = within(reopened).getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '100');
    await userEvent.click(within(reopened).getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(4));

    expect(onTip.mock.calls[2][1]).toBe(50);
    const firstKeys = [onTip.mock.calls[0][2], onTip.mock.calls[1][2]];
    const secondKeys = [onTip.mock.calls[2][2], onTip.mock.calls[3][2]];
    // 🔴 A completed tip's keys can never be reused — replaying one would make
    // the server return the FIRST tip's result and silently send nothing.
    expect(secondKeys.every((k) => k != null && !firstKeys.includes(k))).toBe(true);
  });
});

// ===========================================================================
// The app's own Escape gate (it moved here with the picker)
// ===========================================================================

describe("🔴 the app's window-level Escape must not dismiss the picker mid-transfer", () => {
  it('leaves it open while a leg is on the wire, and closes it once it is not', async () => {
    // The app registers a SECOND, window-level Escape handler on top of `Modal`'s
    // own (which sits on `document` and never sees a `window`-dispatched key).
    // Gating the modal alone would leave this one dismissing the picker while a
    // POST is in flight: the Buzz still leaves the account, and the
    // partial-failure UI never appears to say so.
    let release: (ok: boolean) => void = () => {};
    const onTip = vi.fn(
      (_t: TipTarget, _a: number, _k?: string) => new Promise<boolean>((r) => { release = r; }),
    ) as unknown as TipMock;
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);

    await openPicker();
    // Control: Escape DOES close it before any send.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    await openPicker();
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('tip-split-modal')).toBeInTheDocument();

    await act(async () => release(false));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));
    await act(async () => release(false));
    await screen.findByTestId('split-partial');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());
  });
});

// ===========================================================================
// C8 — self-tip collapse, through the consolidated control
// ===========================================================================

describe('self-tip collapse, and the "nobody to pay" state', () => {
  it('🔴 the CURATOR viewing their own collection sees no curator side and no chip row', async () => {
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} viewerUserId={CURATOR} />);
    const modal = await openPicker();

    expect(screen.queryByTestId('split-preview-curator')).toBeNull();
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 50 Buzz');
    // 🔴 The destination row is ABSENT, not disabled — with one side collapsed
    // there is exactly one destination, and a chip row with no choice in it
    // reads as an option the viewer could have taken.
    expect(within(modal).queryByTestId('tip-target-curator')).toBeNull();
    expect(within(modal).queryByTestId('tip-target-split')).toBeNull();
    expect(modal).toHaveTextContent('You curate this collection');

    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));
    // The WHOLE 50 — not 25 with the other half quietly dropped.
    expect(onTip.mock.calls[0][0]).toMatchObject({ toUserId: BOB });
    expect(onTip.mock.calls[0][1]).toBe(50);
  });

  it('the CREATOR of the media on screen sees no creator side', async () => {
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} viewerUserId={BOB} />);
    const modal = await openPicker();

    expect(screen.queryByTestId('split-preview-creator')).toBeNull();
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 50 Buzz');
    expect(modal).toHaveTextContent('This is your media');

    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));
    expect(onTip.mock.calls[0][0]).toMatchObject({ toUserId: CURATOR });
    expect(onTip.mock.calls[0][1]).toBe(50);
  });

  it('BOTH sides self: the one control is disabled and says why, in every mode', async () => {
    const mine = img(7001, VIEWER, 'me');
    const onTip = makeTip();
    render(
      <CollectionViewer
        detail={{ ...detail, curator: { userId: VIEWER, username: 'me' } }}
        items={[mine]}
        settings={{ secondsPerImage: 5, videoLoopCount: 1 }}
        onSecondsPerImageChange={() => {}}
        onVideoLoopCountChange={() => {}}
        viewerUserId={VIEWER}
        buzzBalance={5000}
        followed={false}
        onFollowChange={() => {}}
        onTip={onTip}
        tipping={false}
        splitPlans={{}}
        onSplitPlanChange={() => {}}
        isMobile={false}
        c={c}
        onExit={() => {}}
        storage={memStorage()}
        reducedMotion
      />,
    );

    for (const mode of ['classic', 'continuous-horizontal', 'continuous-vertical'] as const) {
      await switchTo(mode);
      const btn = screen.getByTestId('chrome-tip');
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute(
        'title',
        "This is your own media in your own collection — there's no one to tip.",
      );
    }
    expect(onTip).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// C9 — the daily allowance is spent against the TOTAL, so both legs debit it
// ===========================================================================

describe('🔴 the remaining daily allowance is checked against the TOTAL, not a leg', () => {
  it('refuses a 400 split when 300 is left — each leg is 200 and would pass alone', async () => {
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} dailyTipRemaining={300} />);
    const modal = await openPicker();
    expect(within(modal).getByTestId('tip-split-allowance')).toHaveTextContent('Up to 300 Buzz in total.');

    const input = within(modal).getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '400');
    expect(await screen.findByTestId('split-error')).toHaveTextContent(
      "Only 300 Buzz left in today's tip allowance.",
    );
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    expect(onTip).not.toHaveBeenCalled();

    // The discriminator: 300 is exactly the allowance and splits to 150/150, so
    // this passes whether the check is per-leg or on the total — it proves the
    // refusal above is a refusal and not a stuck control.
    await userEvent.clear(input);
    await userEvent.type(input, '300');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));
    expect(onTip.mock.calls[0][1] + onTip.mock.calls[1][1]).toBe(300);
  });

  it('🔴 the per-press cap is on the SUM too: 5000 splits 2500/2500, 5001 is refused', async () => {
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    const modal = await openPicker();
    const input = within(modal).getByTestId('split-amount-input');

    await userEvent.clear(input);
    await userEvent.type(input, '5001');
    expect(await screen.findByTestId('split-error')).toHaveTextContent(
      'Maximum is 5,000 Buzz per tip in total.',
    );
    expect(onTip).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, '5000');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));
    // 🔴 The point of the whole cap: the SUM is 5000, not 10000. The server's
    // `TIP_MAX_PER_TIP` is PER TRANSFER, so both legs of a 10000 press would
    // clear it individually.
    expect(onTip.mock.calls[0][1] + onTip.mock.calls[1][1]).toBe(5000);
  });
});

// ===========================================================================
// Logged out
// ===========================================================================

describe('an anon viewer is bounced to sign-in BEFORE the amount picker', () => {
  it.each(['classic', 'continuous-vertical'] as const)('in %s', async (mode) => {
    const onRequestSignIn = vi.fn();
    render(
      <CollectionViewer
        detail={detail}
        items={[byBob, byCarol]}
        settings={{ secondsPerImage: 5, videoLoopCount: 1 }}
        onSecondsPerImageChange={() => {}}
        onVideoLoopCountChange={() => {}}
        viewerUserId={null}
        buzzBalance={null}
        followed={false}
        onFollowChange={() => {}}
        onTip={makeTip()}
        onRequestSignIn={onRequestSignIn}
        tipping={false}
        splitPlans={{}}
        onSplitPlanChange={() => {}}
        isMobile={false}
        c={c}
        onExit={() => {}}
        storage={memStorage()}
        reducedMotion
      />,
    );
    await switchTo(mode);
    await userEvent.click(screen.getByTestId('chrome-tip'));
    expect(onRequestSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tip-split-modal')).toBeNull();
  });
});

// ===========================================================================
// The CONSENT GATE — a viewer without `social:tip:self` must be ASKED, not walked
// into a picker that cannot send.
//
// 🔴 THIS IS A REGRESSION TEST, NOT AN INVARIANT GUARD. Before the fix the first
// case FAILS: the press opened `tip-split-modal` and never called the consent
// callback, which is precisely the live behaviour measured on 2026-09-08 — the
// mint is fail-closed on a missing grant row, so the token arrived with no tip
// scope, the server refused every leg at the scope gate, and the viewer got
// "None of that tip came back confirmed" with no route to fix it.
// ===========================================================================

describe('🔴 the tip press asks for consent when the token cannot tip', () => {
  it('WITHOUT the scope: the press requests consent and NO picker opens', async () => {
    const onRequestTipConsent = vi.fn();
    render(
      <Host
        items={[byBob, byCarol]}
        onTip={makeTip()}
        hasTipScope={false}
        onRequestTipConsent={onRequestTipConsent}
      />,
    );
    await userEvent.click(screen.getByTestId('chrome-tip'));
    expect(onRequestTipConsent).toHaveBeenCalledTimes(1);
    // The whole point: no picker. A picker here can only end in "not sent".
    expect(screen.queryByTestId('tip-split-modal')).toBeNull();
  });

  it('POSITIVE CONTROL — WITH the scope the picker opens and consent is NOT requested', async () => {
    const onRequestTipConsent = vi.fn();
    render(
      <Host
        items={[byBob, byCarol]}
        onTip={makeTip()}
        hasTipScope
        onRequestTipConsent={onRequestTipConsent}
      />,
    );
    await userEvent.click(screen.getByTestId('chrome-tip'));
    expect(await screen.findByTestId('tip-split-modal')).toBeInTheDocument();
    expect(onRequestTipConsent).not.toHaveBeenCalled();
  });

  it('a LOGGED-OUT viewer routes to SIGN-IN, not to consent — the order matters', async () => {
    const onRequestTipConsent = vi.fn();
    const onRequestSignIn = vi.fn();
    render(
      <Host
        items={[byBob, byCarol]}
        onTip={makeTip()}
        viewerUserId={null}
        hasTipScope={false}
        onRequestTipConsent={onRequestTipConsent}
        onRequestSignIn={onRequestSignIn}
      />,
    );
    await userEvent.click(screen.getByTestId('chrome-tip'));
    // Both guards would fire on this fixture; sign-in must win. Asking a
    // logged-out viewer to grant a scope is asking for something they cannot
    // give — there is no account for the grant to attach to.
    expect(onRequestSignIn).toHaveBeenCalledTimes(1);
    expect(onRequestTipConsent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tip-split-modal')).toBeNull();
  });
});
