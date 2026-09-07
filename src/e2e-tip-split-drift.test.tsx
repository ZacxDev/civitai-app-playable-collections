// 🔴 THE SPLIT POPOVER'S RECIPIENTS MUST BE FROZEN AT THE MOMENT IT OPENS.
//
// The rest of the suite is STRUCTURALLY BLIND to this: every other e2e finishes
// in milliseconds under real timers, so `usePlayer`'s image auto-advance
// (`secondsPerImage`, default 5 s) never fires while a picker is open. These
// tests hold the popover open across one full advance interval, which is the
// exact thing a viewer does by reading the preview before pressing Send.
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
  await user.click(screen.getByTestId('tip-split'));
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

describe('🔴 the split popover pins its recipients when it opens', () => {
  it('pays the creator the viewer was LOOKING AT, not whoever the timer advanced to', async () => {
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

    // 🔴 THE ASSERTION THAT MATTERS: who was actually paid, and for what.
    // Pre-fix this sends 25 to CAROL against media 1002 — a creator the viewer
    // never saw in the preview and never agreed to pay.
    expect(api.__tips()[0]).toMatchObject({ toUserId: BOB, amount: 25, entityType: 'Image', entityId: 1001 });
    expect(api.__tips()[1]).toMatchObject({ toUserId: CURATOR_ID, amount: 25, entityType: 'Collection', entityId: 501 });
    expect(api.__tips().map((t) => t.toUserId)).toEqual([BOB, CURATOR_ID]);
    expect(api.__balance()).toBe(4950);
  });

  it('does not COLLAPSE the split when the next item happens to be the viewer’s own', async () => {
    // The aggravating shape: `splitCreator` goes null for a self-owned item, so
    // a drifted popover silently becomes a curator-only tip carrying the WHOLE
    // total — one recipient instead of two, and double what was previewed.
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
