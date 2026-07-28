import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import type { ViewerInfo } from '@civitai/app-sdk/blocks';

import { App } from './App.js';
import { ApiError, type ApiClient } from './lib/api.js';
import { createFakeApi, type FakeApi } from './fake-api.js';

async function openNeon(api: ApiClient, viewer: ViewerInfo | null = { id: 99, username: 'me' }) {
  render(
    <Harness viewer={viewer} theme="dark" showLog={false}>
      <App api={api} />
    </Harness>,
  );
  const grid = await screen.findByTestId('collection-grid');
  // Neon Cities (id 101) is the first public seed collection.
  const cards = within(grid).getAllByTestId('collection-card');
  await userEvent.click(cards[0]);
  await screen.findByTestId('player');
}

describe('open a collection → player', () => {
  it('renders the first media item', async () => {
    const api = createFakeApi({ viewerUserId: 99 }) as FakeApi;
    await openNeon(api);
    expect(screen.getByTestId('media-image')).toBeInTheDocument();
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
  });

  it('exits back to the grid', async () => {
    const api = createFakeApi();
    await openNeon(api);
    await userEvent.click(screen.getByTestId('player-exit'));
    expect(await screen.findByTestId('collection-grid')).toBeInTheDocument();
  });
});

describe('keyboard + swipe navigation', () => {
  it('advances with ArrowRight and goes back with ArrowLeft', async () => {
    const api = createFakeApi();
    await openNeon(api);
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 3');
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
  });

  it('advances on a left swipe and goes back on a right swipe', async () => {
    const api = createFakeApi();
    await openNeon(api);
    const stage = screen.getByTestId('media-stage');
    // swipe left (next)
    fireEvent.touchStart(stage, { touches: [{ clientX: 300 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 200 }] });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 3');
    // swipe right (prev)
    fireEvent.touchStart(stage, { touches: [{ clientX: 200 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 320 }] });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
  });
});

describe('tip flow', () => {
  it('tips the creator: optimistic "tipped" state + balance decrement', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 5000 }) as FakeApi;
    await openNeon(api);
    // First item creator is bob (22) — not the viewer — so tipping is allowed.
    await userEvent.click(screen.getByTestId('tip-creator'));
    const modal = await screen.findByTestId('tip-modal');
    // default preset amount is 50
    await userEvent.click(within(modal).getByTestId('tip-confirm'));
    await waitFor(() => expect(api.__tips()).toHaveLength(1));
    expect(api.__tips()[0]).toMatchObject({ toUserId: 22, amount: 50, entityType: 'Image' });
    expect(api.__balance()).toBe(4950);
    // optimistic tipped state: the button now reads "Tipped creator"
    await waitFor(() =>
      expect(screen.getByTestId('tip-creator')).toHaveAttribute('aria-label', 'Tipped creator'),
    );
    expect(await screen.findByTestId('toast-success')).toBeInTheDocument();
  });

  it('disables the tip button for a self-owned creator', async () => {
    // viewer is bob (22); first item creator is bob (22) => self-tip.
    const api = createFakeApi({ viewerUserId: 22 });
    await openNeon(api, { id: 22, username: 'bob' });
    expect(screen.getByTestId('tip-creator')).toBeDisabled();
  });

  it('validates the tip amount (0 is rejected)', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    const input = await screen.findByTestId('tip-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '0');
    expect(await screen.findByTestId('tip-error')).toBeInTheDocument();
    expect(screen.getByTestId('tip-confirm')).toBeDisabled();
  });

  it('surfaces insufficient balance as a clean toast and does not mark tipped', async () => {
    // Client sees a healthy balance (so the 50 default passes client validation),
    // but the SERVER rejects the tip with insufficient_balance — the real "your
    // balance changed underneath you" path.
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 });
    const api: ApiClient = {
      ...base,
      async tip() {
        throw new ApiError('insufficient_balance', 403, 'Not enough Buzz.');
      },
    };
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    const modal = await screen.findByTestId('tip-modal');
    await userEvent.click(within(modal).getByTestId('tip-confirm'));
    expect(await screen.findByTestId('toast-error')).toHaveTextContent(/enough Buzz/i);
    // modal stays open (tip not marked); button not in tipped state
    expect(screen.getByTestId('tip-creator')).toHaveAttribute('aria-label', 'Tip creator');
  });
});

describe('tip caps + rate limiting (ship-blocker #2)', () => {
  it('surfaces the server Retry-After on a rate-limited tip', async () => {
    const api = createFakeApi({ viewerUserId: 99, failMode: 'rate_limited' });
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    const modal = await screen.findByTestId('tip-modal');
    await userEvent.click(within(modal).getByTestId('tip-confirm'));
    // The fake throws rate_limited with retryAfterMs 2000 → surfaced as "2s".
    expect(await screen.findByTestId('toast-error')).toHaveTextContent(/try again in 2s/);
  });

  it('reduces the displayed daily allowance after a successful tip', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 100000 }) as FakeApi;
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    expect(screen.getByTestId('tip-allowance')).toHaveTextContent('25,000 of 25,000 Buzz left today');
    await userEvent.click(within(await screen.findByTestId('tip-modal')).getByTestId('tip-confirm')); // tips 50
    await waitFor(() => expect(api.__tips()).toHaveLength(1));
    // Reopen the tip modal — the app-local allowance now reflects the 50 spent.
    await userEvent.click(screen.getByTestId('tip-curator'));
    await waitFor(() =>
      expect(screen.getByTestId('tip-allowance')).toHaveTextContent('24,950 of 25,000 Buzz left today'),
    );
  });
});

describe('follow toggle', () => {
  it('optimistically follows then confirms', async () => {
    const api = createFakeApi({ viewerUserId: 99 }) as FakeApi;
    await openNeon(api);
    const btn = screen.getByTestId('follow-toggle');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    await waitFor(() => expect(api.__isFollowed(101)).toBe(true));
    expect(screen.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  it('rolls back on a follow error', async () => {
    const base = createFakeApi({ viewerUserId: 99 });
    const api: ApiClient = {
      ...base,
      async setFollow() {
        throw new ApiError('forbidden', 403, 'nope');
      },
    };
    await openNeon(api);
    const btn = screen.getByTestId('follow-toggle');
    await userEvent.click(btn);
    // optimistic true, then rollback to false + error toast
    await waitFor(() => expect(screen.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'false'));
    expect(await screen.findByTestId('toast-error')).toBeInTheDocument();
  });
});

describe('popular rail (shared play-counts)', () => {
  it('appears on discover after a collection has been played (recordPlay → mock host SHARED store)', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    await openNeon(api);
    await userEvent.click(screen.getByTestId('player-exit'));
    // Back on discover, the popular rail should now include the played collection.
    // Opening it fired `recordPlay(shared, …)` which appended + self-voted an
    // entry in the host's SHARED store; `readPopular` reads it back (count 1).
    await waitFor(() => expect(screen.queryByTestId('popular-rail')).toBeInTheDocument());
    const rail = screen.getByTestId('popular-rail');
    expect(rail).toHaveTextContent('Neon Cities');
    expect(within(rail).getByTestId('popular-card')).toHaveAttribute(
      'aria-label',
      'Play Neon Cities — played 1 times',
    );
  });

  it('ranks the rail by distinct-viewer vote count (desc) from the seeded SHARED store', async () => {
    // Seed the mock host's SHARED store directly with two collection entries at
    // different vote counts — proves `readPopular` ranks by count, not insertion
    // order, and resolves each entry's collectionId back to a known card.
    const api = createFakeApi({ viewerUserId: 99 });
    render(
      <Harness
        viewer={{ id: 99, username: 'me' }}
        theme="dark"
        showLog={false}
        shared={{
          seed: [
            // Newest-first insertion order is [101, 102]; votes invert that so a
            // pure insertion-order rail would be WRONG.
            { value: { title: 'Neon Cities', data: { collectionId: 101 } }, voters: [1] }, // count 1
            { value: { title: 'Forest Studies', data: { collectionId: 102 } }, voters: [1, 2, 3] }, // count 3
          ],
        }}
      >
        <App api={api} />
      </Harness>,
    );
    await screen.findByTestId('collection-grid');
    const rail = await screen.findByTestId('popular-rail');
    const cards = within(rail).getAllByTestId('popular-card');
    // Ranked count-desc: Forest Studies (3) before Neon Cities (1).
    expect(cards[0]).toHaveAttribute('aria-label', 'Play Forest Studies — played 3 times');
    expect(cards[1]).toHaveAttribute('aria-label', 'Play Neon Cities — played 1 times');
  });
});
