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
}: {
  items: MediaItem[];
  onTip: TipMock;
  viewerUserId?: number | null;
  dailyTipRemaining?: number;
  storage?: Storage;
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
    reducedMotion: true,
  };
  return <CollectionViewer {...props} />;
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
// C6 — the plan outlives everything that unmounts a surface
// ===========================================================================

describe('🔴 a half-failed plan survives the four things that unmount a surface', () => {
  /** Refuse the curator leg exactly once, then accept it. */
  function curatorRefusedOnce(): TipMock {
    let attempts = 0;
    return vi.fn(async (target: TipTarget, _amount: number, _idempotencyKey?: string) => {
      if (target.kind === 'curator' && ++attempts === 1) return false;
      return true;
    });
  }

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
