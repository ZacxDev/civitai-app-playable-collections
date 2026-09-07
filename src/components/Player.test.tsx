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

type TipMock = ReturnType<typeof makeTip>;
function makeTip() {
  return vi.fn(async (_target: TipTarget, _amount: number, _idempotencyKey?: string) => true);
}

/**
 * Renders Player under an owner that holds the split plans, the way App does —
 * a constant `splitPlans={{}}` would make the partial-failure panel unreachable
 * and quietly hollow out every retry assertion below.
 */
function Host({ items, onTip }: { items: MediaItem[]; onTip: TipMock }) {
  const [splitPlans, setSplitPlans] = useState<PlayerProps['splitPlans']>({});
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
    onTip,
    tipping: false,
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
  it('does not carry a half-failed plan across to a DIFFERENT item', async () => {
    // The behavioural companion to `splitTipKey`'s structural guard. If the key
    // ignored the entity, opening the split on the next image would resume the
    // previous image's half-failed plan: the viewer would be shown a
    // partial-failure panel and a Retry for a tip they never started here, and
    // pressing it would replay keys the server has already terminal-ised.
    const onTip = vi.fn(async (target: TipTarget) => target.kind !== 'curator');
    render(<Host items={[byBob, byCarol]} onTip={onTip} />);

    await userEvent.click(screen.getByTestId('tip-split'));
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    await userEvent.click(screen.getByTestId('split-cancel'));

    // Move to carol's image, then open the split there.
    await userEvent.click(screen.getByTestId('ctrl-next'));
    await userEvent.click(screen.getByTestId('tip-split'));
    await screen.findByTestId('tip-split-modal');

    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@carol (creator): 25 Buzz');
    expect(screen.queryByTestId('split-partial')).toBeNull();
    expect(screen.getByTestId('split-confirm')).toBeInTheDocument();

    // …while bob's plan is untouched: going back resumes it.
    await userEvent.click(screen.getByTestId('split-cancel'));
    await userEvent.click(screen.getByTestId('ctrl-prev'));
    await userEvent.click(screen.getByTestId('tip-split'));
    expect(await screen.findByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
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
});
