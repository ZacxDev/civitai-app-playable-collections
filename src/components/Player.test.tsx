// Player — the SNAPSHOT contract of the split popover, isolated from the timer.
//
// 🔴 WHY THIS EXISTS ALONGSIDE `e2e-tip-split-drift.test.tsx`. That file drives
// the real drift (the image auto-advance) end to end, and PAUSING the player
// while a picker is open is enough to make it green. Pausing is defence in
// depth, not the fix: the recipients must be pinned at open time regardless of
// WHY the media underneath moved. So this file moves the media by re-rendering
// `items` — a path no pause can intercept — and asserts the popover still pays
// the person the viewer was shown.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import { BrowsingLevel, SFW_LEVELS } from '@civitai/app-sdk/blocks';

import { Player, type PlayerProps } from './Player.js';
import { palette } from '../theme.js';
import type { TipTarget } from './TipModal.js';
import type { CollectionDetail, MediaItem } from '../types.js';

const c = palette();

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

/**
 * Renders Player under an owner that holds the split plans, the way App does —
 * a constant `splitPlans={{}}` would make the partial-failure panel unreachable
 * and quietly hollow out every retry assertion below.
 */
function Host({
  items,
  onTip,
  trackTipping = false,
}: {
  items: MediaItem[];
  onTip: TipMock;
  /**
   * Mirror App's `doTip`: raise the shared in-flight flag for the duration of a
   * transfer. OFF by default and opted into by exactly one test — turning it on
   * everywhere would make `tipping` cover the SPLIT popover's in-flight window
   * too, which would hollow out the `splitSending` witness below (it would pass
   * with `!splitSending` deleted).
   */
  trackTipping?: boolean;
}) {
  const [splitPlans, setSplitPlans] = useState<PlayerProps['splitPlans']>({});
  const [tipping, setTipping] = useState(false);
  const tracked = (async (target: TipTarget, amount: number, key?: string) => {
    setTipping(true);
    try {
      return await onTip(target, amount, key);
    } finally {
      setTipping(false);
    }
  }) as unknown as TipMock;
  const props: PlayerProps = {
    detail,
    items,
    settings: { secondsPerImage: 5, videoLoopCount: 1 },
    onSecondsPerImageChange: () => {},
    onVideoLoopCountChange: () => {},
    viewerUserId: 99,
    buzzBalance: 5000,
    followed: false,
    onFollowChange: () => {},
    onNotice: () => {},
    onFollowUncertain: () => {},
    onTip: trackTipping ? tracked : onTip,
    tipping: trackTipping ? tipping : false,
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
  };
  return <Player {...props} />;
}

describe('🔴 the split popover freezes its recipients at open, not at confirm', () => {
  it('keeps paying the creator it previewed even when the media underneath is replaced', async () => {
    const onTip = makeTip();
    const { rerender } = render(<Host items={[byBob, byCarol]} onTip={onTip} />);

    await userEvent.click(screen.getByTestId('tip-split'));
    await screen.findByTestId('tip-split-modal');
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');

    // The media on screen is replaced under the open popover. A pause cannot
    // stop this — the list itself changed (a filter, a shuffle, a reload).
    rerender(<Host items={[byCarol, byBob]} onTip={onTip} />);
    // The stage really did move …
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', byCarol.url);
    // … and the popover really did not.
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');

    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));

    expect(onTip.mock.calls[0][0]).toMatchObject({ kind: 'creator', toUserId: BOB, entityType: 'Image', entityId: 1001 });
    expect(onTip.mock.calls[0][1]).toBe(25);
    expect(onTip.mock.calls[1][0]).toMatchObject({ kind: 'curator', toUserId: CURATOR, entityType: 'Collection', entityId: 501 });
    expect(onTip.mock.calls[1][1]).toBe(25);
  });

  it('marks the ✓ against the media that was TIPPED, not the one now on screen', async () => {
    const onTip = makeTip();
    const { rerender } = render(<Host items={[byBob, byCarol]} onTip={onTip} />);
    await userEvent.click(screen.getByTestId('tip-split'));
    await screen.findByTestId('tip-split-modal');

    rerender(<Host items={[byCarol, byBob]} onTip={onTip} />);
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    // Carol's media (1002) is what is on screen, and it was NOT tipped — so the
    // creator control must still read as untipped. Pre-fix `onSplitDone` reads
    // the LIVE recipients, so the ✓ lands on whatever drifted into view.
    expect(screen.getByTestId('tip-creator')).toHaveAttribute('aria-pressed', 'false');
    // The curator leg genuinely landed against this collection, so that one IS marked.
    expect(screen.getByTestId('tip-curator')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('a resumed plan belongs to ONE logical tip', () => {
  it('does not carry a half-failed plan across to a different image BY THE SAME CREATOR', async () => {
    // The behavioural companion to `splitTipKey`'s structural guard. If the key
    // ignored the entity, opening the split on the next image would resume the
    // previous image's half-failed plan: the viewer would be shown a
    // partial-failure panel and a Retry for a tip they never started here, and
    // pressing it would replay keys the server has already terminal-ised.
    //
    // 🔴 BOTH ITEMS ARE BY BOB, AND THAT IS THE POINT. The pair the title names
    // is the pair a key of `${toUserId}` alone cannot separate; a
    // bob-then-carol fixture passes with the entity dropped from the key and
    // proves nothing about this hazard.
    const onTip = vi.fn(async (target: TipTarget) => target.kind !== 'curator');
    render(<Host items={[byBob, alsoByBob]} onTip={onTip} />);

    await userEvent.click(screen.getByTestId('tip-split'));
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    await userEvent.click(screen.getByTestId('split-cancel'));

    // Move to bob's OTHER image, then open the split there.
    await userEvent.click(screen.getByTestId('ctrl-next'));
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2');
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', alsoByBob.url);
    await userEvent.click(screen.getByTestId('tip-split'));
    await screen.findByTestId('tip-split-modal');

    // A brand-new tip: no partial-failure panel, a live Send, nothing locked.
    // (The preview text is identical on both images here — same creator, same
    // amount — so it is deliberately NOT the discriminator.)
    expect(screen.queryByTestId('split-partial')).toBeNull();
    expect(screen.getByTestId('split-confirm')).not.toBeDisabled();
    expect(screen.getByTestId('split-amount-input')).not.toBeDisabled();

    // …while bob's plan is untouched: going back resumes it.
    await userEvent.click(screen.getByTestId('split-cancel'));
    await userEvent.click(screen.getByTestId('ctrl-prev'));
    await userEvent.click(screen.getByTestId('tip-split'));
    expect(await screen.findByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
  });
});

describe('🔴 a COMPLETED split RETIRES its plan', () => {
  it('reopening the split on the same media gives a fresh, usable picker — not a dead Send', async () => {
    // `onSplitDone` deletes the plan (`onSplitPlanChange(key, null)`), and until
    // this test that deletion had no witness: removing the line left the whole
    // suite green while App's own header cites exactly it as the reason
    // `splitPlans` cannot grow.
    //
    // What a retained plan does to the viewer: the key is per-MEDIA, so
    // reopening the split on the media they just tipped resumes the completed
    // plan. `plan != null` disables the amount, the presets, the slider AND the
    // Send button, and `failed` is false so no Retry ever appears — a picker
    // with no action at all, recoverable only by reloading the page. It also
    // leaks a set of spent idempotency keys for the lifetime of the session.
    const onTip = makeTip();
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);

    await userEvent.click(screen.getByTestId('tip-split'));
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    // Reopen on the SAME media — the same logical tip, the same plan key.
    await userEvent.click(screen.getByTestId('tip-split'));
    await screen.findByTestId('tip-split-modal');

    expect(screen.queryByTestId('split-partial')).toBeNull();
    expect(screen.getByTestId('split-amount-input')).not.toBeDisabled();
    expect(screen.getByTestId('split-preset-100')).not.toBeDisabled();
    expect(screen.getByTestId('split-confirm')).not.toBeDisabled();

    // …and it is usable for real: a SECOND, different tip on the same media,
    // under keys the server has never seen.
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '100');
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(4));

    expect(onTip.mock.calls[2][1]).toBe(50);
    expect(onTip.mock.calls[3][1]).toBe(50);
    const firstKeys = [onTip.mock.calls[0][2], onTip.mock.calls[1][2]];
    const secondKeys = [onTip.mock.calls[2][2], onTip.mock.calls[3][2]];
    // 🔴 A completed tip's keys can never be reused — replaying one would make
    // the server return the FIRST tip's result and silently send nothing.
    expect(secondKeys.every((k) => k != null && !firstKeys.includes(k))).toBe(true);
  });
});

describe("🔴 Player's OWN Escape handler must not dismiss a picker mid-transfer", () => {
  it('leaves the split popover open while a leg is on the wire, and closes it once it is not', async () => {
    // Player registers a SECOND, window-level Escape handler on top of `Modal`'s.
    // Gating the modal alone would leave this one dismissing the popover while a
    // POST is in flight: the Buzz still leaves the account, and the
    // partial-failure UI never appears to say so.
    let release: (ok: boolean) => void = () => {};
    const onTip = vi.fn(
      (_t: TipTarget, _a: number, _k?: string) => new Promise<boolean>((r) => { release = r; }),
    );
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);

    await userEvent.click(screen.getByTestId('tip-split'));
    await screen.findByTestId('tip-split-modal');
    // Control: Escape DOES close it before any send.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('tip-split-modal')).toBeNull();

    await userEvent.click(screen.getByTestId('tip-split'));
    await screen.findByTestId('tip-split-modal');
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('tip-split-modal')).toBeInTheDocument();

    // Leg 1 refused → leg 2 refused → the wire is clear and the panel is showing.
    await act(async () => release(false));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(2));
    await act(async () => release(false));
    await screen.findByTestId('split-partial');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('tip-split-modal')).toBeNull();
  });

  it('leaves the SINGLE-TARGET picker open while its transfer is on the wire', async () => {
    // 🔴 A SECOND JOINT, AND IT HAD NO WITNESS. The `&& !tipping` half of
    // Player's Escape gate covers the single-target picker; deleting just that
    // half (keeping `!splitSending`) left the whole suite green, so the
    // single-target picker's window-level exit was unguarded in practice.
    //
    // 🔴 EVERY KEY EVENT HERE IS DISPATCHED ON `window`, WHICH IS THE ROOT OF
    // THE PROPAGATION PATH — the Modal's own handler sits on `document` and
    // never sees it. So this test can only be satisfied by Player's gate, and
    // deleting the four `TipModal` gates cannot make it pass.
    let release: (ok: boolean) => void = () => {};
    const onTip = vi.fn(
      (_t: TipTarget, _a: number, _k?: string) => new Promise<boolean>((r) => { release = r; }),
    );
    render(<Host items={[byBob, byCarol]} onTip={onTip} trackTipping />);

    await userEvent.click(screen.getByTestId('tip-creator'));
    await screen.findByTestId('tip-modal');
    // Control: Player's window-level Escape DOES close it before any send.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('tip-modal')).toBeNull();

    await userEvent.click(screen.getByTestId('tip-creator'));
    await screen.findByTestId('tip-modal');
    await userEvent.click(screen.getByTestId('tip-confirm'));
    await waitFor(() => expect(onTip).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('tip-modal')).toBeInTheDocument();

    // …and dismissible again the moment the wire is clear (a refused tip leaves
    // the picker up, so Escape is the exit).
    await act(async () => release(false));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('tip-modal')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Player enforces the maturity ceiling ITSELF
// ---------------------------------------------------------------------------
// 🔴 WHY THIS IS TESTED AT THE PLAYER AND NOT ONLY THROUGH CollectionViewer.
// The viewer already filters the list it passes down (it has to — the lightbox
// resolves an index into it), so a Player that ignored the ceiling entirely would
// still LOOK correct in every CollectionViewer test. That is exactly the
// "verified in isolation, broken at the seam" shape, inverted: the seam hides the
// component's own defect. These render Player DIRECTLY, with unfiltered items.

describe('Player — over-ceiling items never reach the stage, whatever the caller passes', () => {
  const at = (mediaId: number, nsfwLevel: number): MediaItem => ({ ...img(mediaId, BOB, 'bob'), nsfwLevel });

  it('🔴 an above-ceiling item handed straight to Player is dropped, not blurred', () => {
    // No <Harness> → the ceiling reads `undefined` → SFW-only (fail closed).
    render(<Host items={[at(1, BrowsingLevel.X), at(2, BrowsingLevel.PG)]} onTip={makeTip()} />);
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 1');
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', at(2, 1).url);
    expect(screen.queryByTestId('maturity-reveal')).toBeNull();
    expect(document.querySelector('[style*="blur("]')).toBeNull();
  });

  it('🔴 SAME X item, an ALL-LEVELS ceiling → it plays, badged X', async () => {
    // The discriminator: without it the test above pins "X is dropped" rather than
    // "X is dropped BY THIS CEILING", and a hardcoded PG-13 line would pass.
    render(
      <Harness showLog={false} maxBrowsingLevel={SFW_LEVELS | BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX}>
        <Host items={[at(1, BrowsingLevel.X), at(2, BrowsingLevel.PG)]} onTip={makeTip()} />
      </Harness>,
    );
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2'));
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('X');
  });

  it('every item above the ceiling → the empty stage, not a blurred one', () => {
    render(<Host items={[at(1, BrowsingLevel.R), at(2, BrowsingLevel.XXX)]} onTip={makeTip()} />);
    expect(screen.getByTestId('player-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('media-image')).toBeNull();
  });
});
