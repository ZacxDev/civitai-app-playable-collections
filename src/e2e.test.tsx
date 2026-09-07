import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness, type HarnessProps } from '@civitai/blocks-react/testing';
import type { ViewerInfo } from '@civitai/app-sdk/blocks';

import { App } from './App.js';
import { ApiError, type ApiClient } from './lib/api.js';
import { createFakeApi, type FakeApi } from './fake-api.js';
import type { TipResult } from './types.js';

async function openNeon(
  api: ApiClient,
  viewer: ViewerInfo | null = { id: 99, username: 'me' },
  // Mock-host knobs. `HarnessProps extends MockHostOptions`, so a host-side
  // refusal (e.g. `collectionFollowError`) is driven from HERE now — following
  // no longer goes through the injected `api`, so a throwing fake cannot
  // reach it.
  hostOptions: Partial<HarnessProps> = {},
) {
  render(
    <Harness viewer={viewer} theme="dark" showLog={false} {...hostOptions}>
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
  it('follows through the HOST BRIDGE and adopts the echo', async () => {
    // 🔴 THIS USED TO ASSERT `api.__isFollowed(101)` AND THAT OBSERVABLE IS GONE
    // ON PURPOSE. The fake ApiClient's follow map was the old HTTP path's
    // server-side state; a bridge follow never touches the injected client, so
    // the map stays false forever and the old assertion would fail against a
    // perfectly working feature. The mock host deliberately keeps NO follow map
    // either — it echoes the request — so the only honest observable is the UI
    // adopting that echo.
    const api = createFakeApi({ viewerUserId: 99 }) as FakeApi;
    await openNeon(api);
    const btn = screen.getByTestId('follow-toggle');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'true'));
    // The fake client is NOT the path any more — pin that, so a silent
    // regression back to the HTTP follow fails here instead of shipping.
    expect(api.__isFollowed(101)).toBe(false);
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

  it('stays unfollowed and shows the error when the HOST refuses', async () => {
    // The refusal is now HOST-side, not a throwing ApiClient — following does
    // not touch the injected fake at all since 0.2.10.
    await openNeon(createFakeApi({ viewerUserId: 99 }), { id: 99, username: 'me' }, {
      collectionFollowError: 'You do not have permission to follow that collection.',
    });
    await userEvent.click(screen.getByTestId('follow-toggle'));
    await waitFor(() => expect(screen.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'false'));
    expect(await screen.findByTestId('toast-error')).toBeInTheDocument();
  });

  it('🔴 a DECLINED follow says NOTHING — the viewer chose no, the app did not fail', async () => {
    // The single most important behaviour change in 0.2.10. Every press now
    // opens a host consent dialog, and dismissing it rejects with `declined`.
    // The pre-0.2.10 code toasted `errMessage(err)` for every rejection, so a
    // viewer who declined would have been told the app failed — which reads as
    // a broken consent prompt.
    await openNeon(createFakeApi({ viewerUserId: 99 }), { id: 99, username: 'me' }, {
      collectionFollowError: 'declined',
    });
    await userEvent.click(screen.getByTestId('follow-toggle'));
    await waitFor(() => expect(screen.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'false'));
    // No error toast, and no success toast either.
    expect(screen.queryByTestId('toast-error')).toBeNull();
    expect(screen.queryByText('Following this collection.')).toBeNull();
  });

  it('a follow refusal for a MISSING SESSION routes to sign-in, not an error', async () => {
    await openNeon(createFakeApi({ viewerUserId: 99 }), { id: 99, username: 'me' }, {
      collectionFollowError: 'sign-in-required',
    });
    await userEvent.click(screen.getByTestId('follow-toggle'));
    await waitFor(() => expect(screen.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.queryByTestId('toast-error')).toBeNull();
  });
});

describe('popular rail (shared play-counts)', () => {
  // 🔴 REPOINTED, NOT DELETED — and this test used to PIN THE DEFECT. It asserted
  // that a SINGLE play puts a collection on a rail headed "🔥 Popular right now",
  // which is the exact behaviour the threshold removes: one play cannot tell
  // "people like this" from "the author opened it once". Its real subject — the
  // recordPlay → SHARED store → readPopular round trip — is unchanged and still
  // asserted below; only the claim about what ONE play earns has moved.
  it('records a play in the SHARED store, but ONE play does not earn the popular rail', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    await openNeon(api);
    await userEvent.click(screen.getByTestId('player-exit'));
    // The play WAS recorded — the collection is reachable on discover as ever …
    await waitFor(() => expect(screen.getByTestId('collection-grid')).toBeInTheDocument());
    expect(screen.getByTestId('collection-grid')).toHaveTextContent('Neon Cities');
    // … and the rail stays absent, with no copy explaining why.
    expect(screen.queryByTestId('popular-rail')).not.toBeInTheDocument();
    expect(screen.queryByText(/Popular right now/)).not.toBeInTheDocument();
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
            // 🔴 All three clear POPULAR_MIN_PLAYS and there are POPULAR_MIN_ENTRIES
            // of them, so the rail renders and the RANKING claim is what is under
            // test. Seeding below the floor would hide the rail and this test
            // would fail for a reason that has nothing to do with ordering.
            { value: { title: 'Neon Cities', data: { collectionId: 101 } }, voters: [1, 2] }, // count 2
            { value: { title: 'Forest Studies', data: { collectionId: 102 } }, voters: [1, 2, 3] }, // count 3
            // 🔴 201 ('My Public Board'), NOT an invented id: `resolvePopularEntries`
            // DROPS an entry whose collectionId resolves to nothing, so an
            // unresolvable companion silently shrinks the set below the entry floor
            // and hides the rail — the test then fails for a reason that has nothing
            // to do with ranking. The fake API ships 101, 102, 201, 202.
            { value: { title: 'My Public Board', data: { collectionId: 201 } }, voters: [1, 2, 3, 4] }, // count 4
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
    expect(cards[0]).toHaveAttribute('aria-label', 'Play My Public Board — played 4 times');
    expect(cards[1]).toHaveAttribute('aria-label', 'Play Forest Studies — played 3 times');
    expect(cards[2]).toHaveAttribute('aria-label', 'Play Neon Cities — played 2 times');
  });
});
