// ---------------------------------------------------------------------------
// 🔴 OPTIMISTIC FLIP AND ROLLBACK — WHERE IT LIVES, AND WHAT THIS APP OWNS
// ---------------------------------------------------------------------------
//
// Complete enumeration of the controls in this app that change state before a
// server confirms: there is exactly ONE, and it is not this app's code.
//
//   - FOLLOW  → upstream `FollowButton` (`@civitai/blocks-react/ui`). It owns
//               the optimistic flip, the revert on rejection, the `declined` and
//               `sign-in-required` special cases, and the note it renders.
//   - TIP     → NOT optimistic. `doTip` awaits `api.tip()` and a non-throwing
//               `{ ok: false }` is treated as a failure; the per-target
//               "Tipped ✓" glyph that once flipped early was removed in T5 (see
//               the header of `e2e.test.tsx`). Nothing is shown as sent until
//               the server says so.
//   - pause / mute / shuffle / filter / view-mode / sort / period → device-local
//               or in-memory only. No write, so no optimism.
//
// So the interesting property is not "does the button revert" — `e2e.test.tsx`
// already pins that, and it is upstream's behaviour anyway. It is the SEAM:
// this app commits follow state (the grid badge, the read-cache drop, the
// analytics event) from `onChange`, which upstream fires ONLY on a confirmed
// host echo. A refusal must therefore leave NO app-side trace. Nothing measured
// that: the repo pinned the confirmed-follow cache drop, and the button's own
// revert, but never that a refused follow commits nothing.
//
// 🔴 THE LIMIT, RESTATED HERE BECAUSE IT BOUNDS EVERY TEST BELOW. `FollowButton`
// exposes no failure or timeout callback (pinned mechanically in
// `follow-failure-contract.test.ts`), so this app CANNOT observe an ambiguous
// outcome — a timeout, or a code-less error raised after the row committed. The
// predecessor `useFollowToggle` dropped the read cache in exactly that case;
// there is no equivalent now, and no test here can create one. What is pinned
// below is the REFUSED case, which upstream does report.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness, type HarnessProps } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import type { ApiClient } from './lib/api.js';
import type { TrackedEvent } from './lib/analytics.js';
import { createFakeApi } from './fake-api.js';

/**
 * Open the first discover card (Neon Cities, id 101 — seeded `followed: false`,
 * as every seed is) with an analytics sink and an `invalidateReads` spy wired.
 */
async function openNeonInstrumented(hostOptions: Partial<HarnessProps> = {}) {
  const events: TrackedEvent[] = [];
  const invalidateReads = vi.fn();
  const api = { ...createFakeApi({ viewerUserId: 99 }), invalidateReads } as unknown as ApiClient;
  render(
    <Harness viewer={{ id: 99, username: 'me' }} theme="dark" showLog={false} {...hostOptions}>
      <App api={api} isTipGranted={() => true} onEvent={(e) => void events.push(e)} />
    </Harness>,
  );
  const grid = await screen.findByTestId('collection-grid');
  // Control: nothing is followed at the start, so a badge appearing later can
  // only have come from the flow under test.
  expect(within(grid).queryAllByTestId('followed-badge')).toHaveLength(0);
  await userEvent.click(within(grid).getAllByTestId('collection-card')[0]);
  await screen.findByTestId('player');
  return { events, invalidateReads };
}

const followEvents = (events: TrackedEvent[]) => events.filter((e) => e.type === 'follow');

describe('follow: the app commits only what the host ECHOED', () => {
  it('a CONFIRMED follow commits: grid badge, cache drop, analytics', async () => {
    // 🔴 THIS IS ALSO THE FIXTURE CONTROL FOR THE REFUSAL CASES BELOW. It is what
    // proves the badge, the spy and the sink can all move at all — without it, a
    // refusal test asserting "no badge / not called / no event" is three zeros
    // from a probe that might be wired to nothing.
    const { events, invalidateReads } = await openNeonInstrumented();

    await userEvent.click(screen.getByTestId('chrome-follow'));
    await waitFor(() =>
      expect(screen.getByTestId('chrome-follow')).toHaveAttribute('aria-pressed', 'true'),
    );

    expect(invalidateReads).toHaveBeenCalledTimes(1);
    expect(followEvents(events)).toEqual([
      expect.objectContaining({ type: 'follow', collectionId: 101, followed: true }),
    ]);

    // …and the grid card the viewer came from now carries the badge.
    await userEvent.click(screen.getByTestId('viewer-exit'));
    const grid = await screen.findByTestId('collection-grid');
    await waitFor(() => expect(within(grid).getAllByTestId('followed-badge')).toHaveLength(1));
  });

  it('🔴 a REFUSED follow rolls back and commits NOTHING — no badge, no cache drop, no event', async () => {
    // The button's own revert + viewer-facing note are upstream's and are pinned
    // in `e2e.test.tsx`; they are re-asserted here only so this test stands on
    // its own. The three assertions that are NEW are the app-side ones.
    const { events, invalidateReads } = await openNeonInstrumented({
      collectionFollowError: 'collection-unavailable',
    });

    await userEvent.click(screen.getByTestId('chrome-follow'));

    // A viewer-facing sentence, announced — never the bare code.
    const note = await screen.findByTestId('chrome-follow-note');
    expect(note).toHaveAttribute('role', 'alert');
    expect(note.textContent ?? '').not.toBe('collection-unavailable');
    expect((note.textContent ?? '').trim().length).toBeGreaterThan(0);

    // The optimistic flip is reverted.
    await waitFor(() =>
      expect(screen.getByTestId('chrome-follow')).toHaveAttribute('aria-pressed', 'false'),
    );

    // 🔴 AND THE APP COMMITTED NOTHING. A commit here would outlive the button:
    // the badge survives an exit, and the cache drop / analytics event are
    // unrecoverable once made.
    //
    // 🔴 ONE ASSERTION OVER ALL THREE, DELIBERATELY. Written as three separate
    // `expect`s the first failure short-circuits the other two, so two of the
    // three guards would never be evaluated on the run that matters and could
    // rot unnoticed. Compared as one object they are all read, every time, and
    // the failure message names which of them moved.
    await userEvent.click(screen.getByTestId('viewer-exit'));
    const grid = await screen.findByTestId('collection-grid');
    expect({
      followEvents: followEvents(events),
      invalidateReadsCalls: invalidateReads.mock.calls.length,
      gridBadges: within(grid).queryAllByTestId('followed-badge').length,
    }).toEqual({ followEvents: [], invalidateReadsCalls: 0, gridBadges: 0 });
  });

  it('🔴 a DECLINED follow commits nothing either — declining is not a write', async () => {
    // Dismissing the host consent dialog rejects with `declined`. The viewer said
    // no, so the same no-trace property must hold, and for a DIFFERENT reason
    // than above: this arm renders nothing at all, so the only observable that
    // something did (or did not) happen is the app-side state.
    const { events, invalidateReads } = await openNeonInstrumented({
      collectionFollowError: 'declined',
    });

    await userEvent.click(screen.getByTestId('chrome-follow'));
    await waitFor(() =>
      expect(screen.getByTestId('chrome-follow')).toHaveAttribute('aria-pressed', 'false'),
    );

    // One assertion over all three, for the reason given in the case above.
    await userEvent.click(screen.getByTestId('viewer-exit'));
    const grid = await screen.findByTestId('collection-grid');
    expect({
      followEvents: followEvents(events),
      invalidateReadsCalls: invalidateReads.mock.calls.length,
      gridBadges: within(grid).queryAllByTestId('followed-badge').length,
    }).toEqual({ followEvents: [], invalidateReadsCalls: 0, gridBadges: 0 });
  });
});
