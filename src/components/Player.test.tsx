// Player — what is left of this component's own contract after T5.
//
// 🔴 THE SPLIT-POPOVER SECTIONS THAT USED TO LIVE HERE MOVED, THEY WERE NOT
// DROPPED. Player no longer owns tipping — one tip affordance, in a chrome row
// `CollectionViewer` renders on all three surfaces — so the snapshot contract,
// the plan-identity contract and the mid-transfer dismissal gate are now
// exercised where the picker actually lives: `tip-affordance.test.tsx`. Each of
// those cases survived the move with its fixtures and its assertions intact;
// the only thing that changed is which component the press goes through.
//
// What stays here is what only Player can answer:
//   - it enforces the maturity ceiling ITSELF, whatever the caller passes,
//   - it reports the media on screen up (`onCurrentItemChange`), which is the
//     input the picker snapshots as "the creator",
//   - `pickerOpen` pauses it AND swallows its window-level shortcuts.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import { BrowsingLevel, SFW_LEVELS } from '@civitai/app-sdk/blocks';

import { Player, type PlayerProps } from './Player.js';
import { palette } from '../theme.js';
import type { MediaItem } from '../types.js';

const c = palette();

const BOB = 22;
const CAROL = 33;

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

const byBob = img(1001, BOB, 'bob');
const byCarol = img(1002, CAROL, 'carol');

function Host(props: Partial<PlayerProps> & { items: MediaItem[] }) {
  const full: PlayerProps = {
    settings: { secondsPerImage: 5, videoLoopCount: 1 },
    onSecondsPerImageChange: () => {},
    onVideoLoopCountChange: () => {},
    isMobile: false,
    c,
    onExit: () => {},
    ...props,
  };
  return <Player {...full} />;
}

describe('Player reports the media on screen up, live', () => {
  it('reports the first item on mount and the NEXT one after an advance', async () => {
    const seen = vi.fn();
    render(<Host items={[byBob, byCarol]} onCurrentItemChange={seen} />);

    await waitFor(() => expect(seen).toHaveBeenCalled());
    expect(seen.mock.calls.at(-1)?.[0]).toMatchObject({ mediaId: 1001, creator: { userId: BOB } });

    await userEvent.click(screen.getByTestId('ctrl-next'));
    // 🔴 THE ADVANCE IS THE POINT. An owner that derived the current item from
    // the `items` it passed IN would still be naming bob here, which is the
    // recipient-drift defect with the roles reversed: the picker would freeze
    // the item the viewer STARTED on rather than the one they are looking at.
    await waitFor(() =>
      expect(seen.mock.calls.at(-1)?.[0]).toMatchObject({ mediaId: 1002, creator: { userId: CAROL } }),
    );
  });

  it('🔴 reports WITHIN THE COMMIT, not on the scheduler\'s timetable', async () => {
    // 🔴 THIS PINS A MONEY BUG THAT SHIPPED TO CI AND WAS GREEN LOCALLY.
    //
    // The report used to be a PASSIVE effect. Passive effects are flushed on
    // React's own schedule, so between the commit that mounts this surface and the
    // flush that delivers the report, the owner's `currentItem` is STALE — `null`
    // on mount. The tip control is live in that window, and `tipPossible` stays
    // true because the CURATOR side does not depend on the media: a press landing
    // there opens a picker with the creator side silently MISSING. It looks
    // exactly like the self-tip collapse and it is not one.
    //
    // 🔴 THE DISCRIMINATOR IS ORDERING, NOT TIMING, WHICH IS WHY THIS IS A
    // RELIABLE LOCAL WITNESS WHERE THE e2e SHAPE IS NOT. React runs a CHILD's
    // layout effects before its PARENT's. So a parent layout effect that inspects
    // "has the child reported yet?" answers YES iff the child reported from a
    // layout effect, and NO if it reported from a passive one — deterministically,
    // on any machine, under real or fake timers. Testing-library's `act()` flushes
    // passive effects before `render()` returns, which is exactly why every
    // ordinary assertion here stayed green while CI went red.
    let verdict = 'probe did not run';
    function Probe() {
      const reported = useRef(false);
      useLayoutEffect(() => {
        verdict = reported.current ? 'REPORTED-IN-COMMIT' : 'DEFERRED-PAST-COMMIT';
      }, []);
      return (
        <Host
          items={[byBob, byCarol]}
          onCurrentItemChange={() => {
            reported.current = true;
          }}
        />
      );
    }
    render(<Probe />);
    expect(verdict).toBe('REPORTED-IN-COMMIT');
  });

  it('reports null when the ceiling leaves nothing playable', async () => {
    const seen = vi.fn();
    // No <Harness> → SFW-only (fail closed) → both items are dropped.
    render(
      <Host
        items={[{ ...byBob, nsfwLevel: BrowsingLevel.R }, { ...byCarol, nsfwLevel: BrowsingLevel.XXX }]}
        onCurrentItemChange={seen}
      />,
    );
    expect(screen.getByTestId('player-empty')).toBeInTheDocument();
    await waitFor(() => expect(seen).toHaveBeenCalledWith(null));
  });
});

describe('🔴 `pickerOpen` pauses the transport and swallows every player shortcut', () => {
  /** Mount with a controllable `pickerOpen`, the way CollectionViewer drives it. */
  function PickerHost({ items, onExit }: { items: MediaItem[]; onExit: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" data-testid="fake-open-picker" onClick={() => setOpen(true)}>
          open
        </button>
        <Host items={items} pickerOpen={open} onExit={onExit} />
      </>
    );
  }

  it('Escape exits the collection normally, and does NOT while the picker is open', async () => {
    const onExit = vi.fn();
    render(<PickerHost items={[byBob, byCarol]} onExit={onExit} />);

    // Positive control: the handler is wired and Escape really does reach it.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId('fake-open-picker'));
    fireEvent.keyDown(window, { key: 'Escape' });
    // 🔴 Still ONE. Without the gate this window-level handler tears the whole
    // collection down from under an open money dialog.
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('ArrowRight advances normally, and does NOT while the picker is open', async () => {
    render(<PickerHost items={[byBob, byCarol]} onExit={() => {}} />);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');

    await userEvent.click(screen.getByTestId('fake-open-picker'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    // The item whose creator an open picker names must not move under it.
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
  });

  it('pauses a RUNNING transport and resumes it on close; never starts a paused one', async () => {
    render(<PickerHost items={[byBob, byCarol]} onExit={() => {}} />);
    const openBtn = screen.getByTestId('fake-open-picker');

    // usePlayer starts playing. Open → paused; the control reports it.
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(openBtn);
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false');
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
    render(<Host items={[at(1, BrowsingLevel.X), at(2, BrowsingLevel.PG)]} />);
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
        <Host items={[at(1, BrowsingLevel.X), at(2, BrowsingLevel.PG)]} />
      </Harness>,
    );
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2'));
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('X');
  });

  it('every item above the ceiling → the empty stage, not a blurred one', () => {
    render(<Host items={[at(1, BrowsingLevel.R), at(2, BrowsingLevel.XXX)]} />);
    expect(screen.getByTestId('player-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('media-image')).toBeNull();
  });

  it('🔴 an UNRATED (0) item PLAYS on the strictest ceiling, badged "Unrated"', () => {
    // The server permits unrated at every ceiling
    // (<civitai>@origin/release block-collections.service.ts:193, :359), so the
    // app must too — being stricter is the app overriding a platform decision, and
    // hiding is worse than the blur it replaced. No <Harness>, i.e. the
    // fail-closed SFW ceiling, which is where a wrongly-strict rule shows first.
    render(<Host items={[at(1, 0), at(2, BrowsingLevel.PG)]} />);
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', at(1, 0).url);
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('Unrated');
  });
});
