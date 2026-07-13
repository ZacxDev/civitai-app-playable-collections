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
  it('renders the first media item and increments the shared play-count', async () => {
    const api = createFakeApi({ viewerUserId: 99 }) as FakeApi;
    await openNeon(api);
    expect(screen.getByTestId('media-image')).toBeInTheDocument();
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
    await waitFor(() => expect(api.__playCount(101)).toBe(1));
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
  it('appears on discover after a collection has been played', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    await openNeon(api);
    await userEvent.click(screen.getByTestId('player-exit'));
    // Back on discover, the popular rail should now include the played collection.
    await waitFor(() => expect(screen.queryByTestId('popular-rail')).toBeInTheDocument());
    expect(screen.getByTestId('popular-rail')).toHaveTextContent('Neon Cities');
  });
});
