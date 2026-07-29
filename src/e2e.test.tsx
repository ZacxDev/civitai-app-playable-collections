import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import type { ViewerInfo } from '@civitai/app-sdk/blocks';

import { App } from './App.js';
import { ApiError, type ApiClient } from './lib/api.js';
import { createFakeApi, type FakeApi } from './fake-api.js';
import type { TipResult } from './types.js';

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

  it('treats a non-throwing { ok: false } tip as a failure (no success, not marked tipped)', async () => {
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 });
    const api: ApiClient = { ...base, async tip() { return { ok: false }; } };
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    const modal = await screen.findByTestId('tip-modal');
    await userEvent.click(within(modal).getByTestId('tip-confirm'));
    expect(await screen.findByTestId('toast-error')).toBeInTheDocument();
    // A soft-failure must NOT mark the creator tipped.
    expect(screen.getByTestId('tip-creator')).toHaveAttribute('aria-label', 'Tip creator');
  });

  it('shows only the fixed per-tip cap in the tip modal (no untracked daily figure, audit O1)', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 100000 }) as FakeApi;
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    const allowance = screen.getByTestId('tip-allowance');
    expect(allowance).toHaveTextContent('Up to 5,000 Buzz per tip');
    // The inert "of 25,000 left today" readout is gone — it tracked nothing in
    // the opaque-origin sandbox; the server rate limit is the real daily gate.
    expect(allowance).not.toHaveTextContent(/left today/i);
  });

  it('double-clicking Send fires exactly one tip — synchronous double-tip guard (audit M1)', async () => {
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 });
    let resolveTip: (r: TipResult) => void = () => {};
    // Never-resolving until we release it: the tip stays in flight so a second
    // click would double-spend if the ref guard weren't there.
    const tip = vi.fn(() => new Promise<TipResult>((res) => { resolveTip = res; }));
    const api: ApiClient = { ...base, tip };
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    const modal = await screen.findByTestId('tip-modal');
    const confirm = within(modal).getByTestId('tip-confirm');
    // TWO clicks in one tick — before `setTipping(true)`'s re-render can disable
    // the button. Only the synchronous `tipInFlightRef` gate stops the 2nd POST.
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(tip).toHaveBeenCalledTimes(1);
    // Release the in-flight tip so React state flushes cleanly at teardown.
    await act(async () => {
      resolveTip({ ok: true, tip: { amount: 50, toUserId: 22 } });
    });
  });

  it('warns instead of inviting a clean retry when a tip TIMES OUT — may have committed (audit M2)', async () => {
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 });
    const api: ApiClient = {
      ...base,
      // The api layer aborts a hung POST at 15s and throws this retryable network
      // error. A timeout does NOT mean the server didn't commit → ambiguous.
      async tip() {
        throw new ApiError('network', 0, 'The request timed out.');
      },
    };
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    const modal = await screen.findByTestId('tip-modal');
    await userEvent.click(within(modal).getByTestId('tip-confirm'));
    // Ambiguous timeout → a "check your balance" warning (info), NOT a clean
    // error toast that would invite a one-click re-send (double-spend risk).
    expect(await screen.findByTestId('toast-info')).toHaveTextContent(/may have gone through/i);
    expect(screen.queryByTestId('toast-error')).toBeNull();
  });

  it('records + toasts the SERVER-reported tip amount, not the client amount (audit O2)', async () => {
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 });
    // Client sends the default 50, but the server commits 40 (host clamp/round).
    const api: ApiClient = {
      ...base,
      async tip(input) {
        return { ok: true, tip: { amount: 40, toUserId: input.toUserId } };
      },
    };
    await openNeon(api);
    await userEvent.click(screen.getByTestId('tip-creator'));
    const modal = await screen.findByTestId('tip-modal');
    await userEvent.click(within(modal).getByTestId('tip-confirm')); // client default 50
    // The success toast reflects the SERVER figure (40), never the requested 50.
    const toast = await screen.findByTestId('toast-success');
    expect(toast).toHaveTextContent('40');
    expect(toast).not.toHaveTextContent('50');
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

  it('uses ONE consistent "follow" verb across the button and both toasts (dogfood: described 3 ways)', async () => {
    const api = createFakeApi({ viewerUserId: 99 }) as FakeApi;
    await openNeon(api);
    const btn = screen.getByTestId('follow-toggle');
    // Follow → the toast uses the SAME verb as the button ("Following"), never the
    // old "Added to your collections." / "bookmark" wording. (Toasts stack, so
    // assert by unique text rather than the shared testid.)
    await userEvent.click(btn);
    expect(await screen.findByText('Following this collection.')).toBeInTheDocument();
    expect(screen.queryByText(/bookmark|Added to your collections/i)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'true'));

    // Unfollow → the mirror verb ("Unfollowed"), still never "bookmark".
    await userEvent.click(screen.getByTestId('follow-toggle'));
    expect(await screen.findByText('Unfollowed this collection.')).toBeInTheDocument();
    expect(screen.queryByText(/bookmark/i)).toBeNull();
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
