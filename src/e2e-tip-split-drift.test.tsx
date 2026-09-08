// 🔴 THE SPLIT POPOVER MUST PAY THE PEOPLE IT PREVIEWED, END TO END, WITH THE
// AUTO-ADVANCE TIMER RUNNING.
//
// The rest of the suite is STRUCTURALLY BLIND to the timer: every other e2e
// finishes in milliseconds under real timers, so `usePlayer`'s image
// auto-advance (`secondsPerImage`, default 5 s) never fires while a picker is
// open. These tests hold the popover open across one full advance interval,
// which is the exact thing a viewer does by reading the preview before pressing
// Send, and follow the money all the way to `api.__tips()`.
//
// 🔴 BUT READ WHAT THEY ARE AND ARE NOT. The third test below proves the picker
// PAUSES playback, so in tests 1 and 2 the interval that elapses moves nothing:
// they exercise the whole app stack across a timer tick, they do NOT distinguish
// a popover that froze its recipients from one that re-derives them live. That
// distinction is pinned in `components/Player.test.tsx`, which moves the media
// by replacing `items` — a path no pause can intercept. The titles here are
// deliberately narrowed to what these bodies actually settle; do not widen them
// back without making the drift real.
//
// 🔴 THEY ASSERT ON THE RECIPIENT IDS ACTUALLY SENT, NOT ON THE PREVIEW TEXT.
// The preview and the send must agree, and it is the send that moves money — a
// popover whose preview is right and whose send is wrong is the worst shape of
// this defect, not a milder one.
//
// Fake timers are installed with `shouldAdvanceTime` so testing-library's
// `waitFor`/`findBy*` (which poll on timers) still settle, while
// `vi.advanceTimersByTime` can jump a whole image interval on demand.

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import type { ViewerInfo } from '@civitai/app-sdk/blocks';

import { App } from './App.js';
import type { ApiClient } from './lib/api.js';
import { createFakeApi, type FakeApi, type SeedCollection } from './fake-api.js';
import { SECONDS_PER_IMAGE } from './settings.js';
import type { MediaItem } from './types.js';

const VIEWER = 99;
const CURATOR_ID = 11; // alice curates the seed collection
const BOB = 22; // creator of the FIRST item — the one the viewer is looking at
const CAROL = 33; // creator of the SECOND item — the one the timer drifts onto

function img(mediaId: number, creator: { userId: number; username: string }): MediaItem {
  return {
    mediaId,
    type: 'image',
    url: `https://example.invalid/i/${mediaId}.jpg`,
    width: 1024,
    height: 1024,
    creator,
    nsfwLevel: 1,
  };
}

/** One public collection, curated by alice, whose two items have DIFFERENT creators. */
function seed(secondItemCreator: { userId: number; username: string }): SeedCollection[] {
  const items = [img(1001, { userId: BOB, username: 'bob' }), img(1002, secondItemCreator)];
  return [
    {
      summary: {
        id: 501,
        name: 'Drift',
        description: null,
        coverImageUrl: items[0].url,
        itemCount: items.length,
        curator: { userId: CURATOR_ID, username: 'alice' },
        isPublic: true,
        followed: false,
      },
      items,
    },
  ];
}

async function openSplitOn(api: ApiClient, viewer: ViewerInfo = { id: VIEWER, username: 'me' }) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(
    <Harness viewer={viewer} theme="dark" showLog={false}>
      <App api={api} />
    </Harness>,
  );
  const grid = await screen.findByTestId('collection-grid');
  await user.click(within(grid).getAllByTestId('collection-card')[0]);
  await screen.findByTestId('player');
  await user.click(screen.getByTestId('chrome-tip'));
  const modal = await screen.findByTestId('tip-split-modal');
  return { user, modal };
}

/** Let one whole image interval elapse, as a viewer reading the preview would. */
function letOneImageIntervalPass() {
  act(() => {
    vi.advanceTimersByTime(SECONDS_PER_IMAGE.default * 1000 + 50);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the split popover, held open across an auto-advance interval', () => {
  it('pays the previewed creator and curator, through the whole app stack', async () => {
    const api = createFakeApi({
      viewerUserId: VIEWER,
      balance: 5000,
      collections: seed({ userId: CAROL, username: 'carol' }),
    }) as FakeApi;
    const { user, modal } = await openSplitOn(api);

    // What the viewer READ before touching anything.
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 25 Buzz');

    letOneImageIntervalPass();

    await user.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(api.__tips()).toHaveLength(2));

    // 🔴 THE ASSERTION THAT MATTERS: who was actually paid, and for what — the
    // real client, the real reducer, the real fake-api ledger.
    // (Pre-fix this sent 25 to CAROL against media 1002. It no longer
    // DISCRIMINATES that fix, because the pause above keeps the media still;
    // `components/Player.test.tsx` is the witness for the freeze itself.)
    expect(api.__tips()[0]).toMatchObject({ toUserId: BOB, amount: 25, entityType: 'Image', entityId: 1001 });
    expect(api.__tips()[1]).toMatchObject({ toUserId: CURATOR_ID, amount: 25, entityType: 'Collection', entityId: 501 });
    expect(api.__tips().map((t) => t.toUserId)).toEqual([BOB, CURATOR_ID]);
    expect(api.__balance()).toBe(4950);
  });

  it('still sends TWO legs when the next item in the collection is the viewer’s own', async () => {
    // The aggravating shape this guards the app against: `splitCreator` goes
    // null for a self-owned item, so a popover that re-derived its recipients
    // would silently become a curator-only tip carrying the WHOLE total — one
    // recipient instead of two, and double what was previewed.
    //
    // 🔴 As above, the pause means the next item never comes on screen here, so
    // this is a two-leg end-to-end assertion rather than a drift witness. The
    // drift itself is exercised in `components/Player.test.tsx`.
    const api = createFakeApi({
      viewerUserId: VIEWER,
      balance: 5000,
      collections: seed({ userId: VIEWER, username: 'me' }),
    }) as FakeApi;
    const { user, modal } = await openSplitOn(api);

    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');

    letOneImageIntervalPass();

    await user.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(api.__tips()).toHaveLength(2));

    expect(api.__tips()[0]).toMatchObject({ toUserId: BOB, amount: 25 });
    expect(api.__tips()[1]).toMatchObject({ toUserId: CURATOR_ID, amount: 25 });
    // Never one leg of 50 to the curator.
    expect(api.__tips().every((t) => t.amount === 25)).toBe(true);
  });

  it('PAUSES playback while a picker is open (defence in depth)', async () => {
    const api = createFakeApi({
      viewerUserId: VIEWER,
      balance: 5000,
      collections: seed({ userId: CAROL, username: 'carol' }),
    }) as FakeApi;
    await openSplitOn(api);

    // Item 1 of 2 on open; still item 1 after an interval, because the picker
    // paused the transport rather than letting the media move under the viewer.
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
    letOneImageIntervalPass();
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
  });
});
