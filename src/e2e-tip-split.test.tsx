// The %-split tip, end to end: real <App/> over the SDK mock host and the
// in-memory `ApiClient` fake, whose `__tips()` / `__balance()` /
// `__tipSpentToday()` are the money observables.
//
// The fake mirrors the server's idempotent replay (a repeated `idempotencyKey`
// returns the first terminal result without transferring again), so the
// partial-failure retry below is a real test of the double-spend guard rather
// than a test of a permissive double.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import type { ViewerInfo } from '@civitai/app-sdk/blocks';

import { App } from './App.js';
import { ApiError, type ApiClient } from './lib/api.js';
import { createFakeApi, type FakeApi, type SeedCollection } from './fake-api.js';
import type { MediaItem, TipInput } from './types.js';

/** Open the first public collection into the player, as `viewer`. */
async function openFirst(api: ApiClient, viewer: ViewerInfo = { id: 99, username: 'me' }) {
  render(
    <Harness viewer={viewer} theme="dark" showLog={false}>
      <App api={api} />
    </Harness>,
  );
  const grid = await screen.findByTestId('collection-grid');
  const cards = within(grid).getAllByTestId('collection-card');
  await userEvent.click(cards[0]);
  await screen.findByTestId('player');
}

/** Open the split popover from the player's right rail. */
async function openSplit() {
  await userEvent.click(screen.getByTestId('tip-split'));
  return screen.findByTestId('tip-split-modal');
}

// Seed 101 "Neon Cities": curated by alice (11), first item created by bob (22).
// With viewer 99 neither side is the viewer, so both legs are live.
const CURATOR_ID = 11;
const CREATOR_ID = 22;

describe('a split tip through the real app', () => {
  it('divides one press between the creator and the curator', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 5000 }) as FakeApi;
    await openFirst(api);
    const modal = await openSplit();
    // Default: 50 Buzz, an even split.
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 25 Buzz');
    await userEvent.click(within(modal).getByTestId('split-confirm'));

    await waitFor(() => expect(api.__tips()).toHaveLength(2));
    expect(api.__tips()[0]).toMatchObject({ toUserId: CREATOR_ID, amount: 25, entityType: 'Image' });
    expect(api.__tips()[1]).toMatchObject({ toUserId: CURATOR_ID, amount: 25, entityType: 'Collection' });
    // 5000 − 25 − 25.
    expect(api.__balance()).toBe(4950);
    // Both legs debit today's allowance — 25 + 25, not 25.
    expect(api.__tipSpentToday()).toBe(50);
    // Every leg carries a key, and the two legs' keys DIFFER (one shared key
    // would make the server replay leg 1's result for leg 2 and silently drop it).
    const keys = api.__tips().map((t) => t.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());
  });

  it('spends exactly 5000 at the cap boundary and refuses 5001', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 100000 }) as FakeApi;
    await openFirst(api);
    const modal = await openSplit();
    const input = within(modal).getByTestId('split-amount-input');

    await userEvent.clear(input);
    await userEvent.type(input, '5001');
    expect(await screen.findByTestId('split-error')).toHaveTextContent('Maximum is 5,000 Buzz per tip in total.');
    expect(api.__tips()).toHaveLength(0);

    await userEvent.clear(input);
    await userEvent.type(input, '5000');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(api.__tips()).toHaveLength(2));
    // 🔴 The point of the whole cap: the SUM is 5000, not 10000.
    expect(api.__tips()[0].amount + api.__tips()[1].amount).toBe(5000);
    expect(api.__balance()).toBe(95000);
  });
});

describe('🔴 partial failure: a LOST response must not become a double-spend', () => {
  /**
   * The curator leg COMMITS server-side and the response is lost on the way back.
   * From inside the iframe that is indistinguishable from a rejection — which is
   * exactly where the retry button lives, and exactly why the key exists.
   */
  function lossyCuratorApi(base: FakeApi): ApiClient {
    let curatorAttempts = 0;
    return {
      ...base,
      async tip(input: TipInput) {
        if (input.toUserId === CURATOR_ID) {
          curatorAttempts += 1;
          if (curatorAttempts === 1) {
            await base.tip(input); // the transfer really happens …
            throw new ApiError('network', 0, 'The request timed out.'); // … the answer never arrives
          }
        }
        return base.tip(input);
      },
    };
  }

  it('retries the outstanding leg under the SAME key — one transfer each, not three', async () => {
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 }) as FakeApi;
    await openFirst(lossyCuratorApi(base));
    const modal = await openSplit();
    await userEvent.click(within(modal).getByTestId('split-confirm'));

    // Both legs transferred; only the curator's ANSWER was lost.
    await waitFor(() => expect(base.__tips()).toHaveLength(2));
    expect(base.__balance()).toBe(4950);
    await screen.findByTestId('split-partial');
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    expect(screen.getByTestId('split-leg-curator')).toHaveAttribute('data-status', 'failed');

    const keyBeforeRetry = base.__tips()[1].idempotencyKey;
    await userEvent.click(screen.getByTestId('split-retry'));
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());

    // 🔴 THE ASSERTION THIS WHOLE FILE EXISTS FOR. Still two transfers, still
    // 4950 Buzz, still 50 against today's allowance. A retry that re-sent the
    // creator leg, or that minted a fresh key for the curator leg, lands here as
    // three tips and a 4925 balance.
    expect(base.__tips()).toHaveLength(2);
    expect(base.__balance()).toBe(4950);
    expect(base.__tipSpentToday()).toBe(50);
    expect(base.__tips().filter((t) => t.toUserId === CREATOR_ID)).toHaveLength(1);
    expect(base.__tips()[1].idempotencyKey).toBe(keyBeforeRetry);
  });

  it('a HARD-refused leg is retryable and the landed leg is never re-sent', async () => {
    // The curator leg is refused outright (403) — nothing committed — twice, then
    // accepted. The creator leg must still appear exactly once.
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 }) as FakeApi;
    let curatorAttempts = 0;
    const api: ApiClient = {
      ...base,
      async tip(input: TipInput) {
        if (input.toUserId === CURATOR_ID && ++curatorAttempts === 1) {
          throw new ApiError('forbidden', 403, 'You do not have permission to do that.');
        }
        return base.tip(input);
      },
    };
    await openFirst(api);
    const modal = await openSplit();
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    expect(base.__tips()).toHaveLength(1);
    expect(base.__balance()).toBe(4975);

    await userEvent.click(screen.getByTestId('split-retry'));
    await waitFor(() => expect(base.__tips()).toHaveLength(2));
    expect(base.__balance()).toBe(4950);
    expect(base.__tips().filter((t) => t.toUserId === CREATOR_ID)).toHaveLength(1);
  });
});

describe('self-tip collapse through the real app (hazard 3)', () => {
  it('the CURATOR viewing their own collection sends the whole total to the creator', async () => {
    // alice (11) curates "Neon Cities"; bob (22) made the first item.
    const api = createFakeApi({ viewerUserId: CURATOR_ID, balance: 5000 }) as FakeApi;
    await openFirst(api, { id: CURATOR_ID, username: 'alice' });
    const modal = await openSplit();
    expect(screen.queryByTestId('split-preview-curator')).toBeNull();
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 50 Buzz');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(api.__tips()).toHaveLength(1));
    // The WHOLE 50 — not 25 with the other half quietly dropped.
    expect(api.__tips()[0]).toMatchObject({ toUserId: CREATOR_ID, amount: 50 });
    expect(api.__balance()).toBe(4950);
  });

  it('the CREATOR of the media on screen sends the whole total to the curator', async () => {
    // bob (22) made the first item of "Neon Cities", curated by alice (11).
    const api = createFakeApi({ viewerUserId: CREATOR_ID, balance: 5000 }) as FakeApi;
    await openFirst(api, { id: CREATOR_ID, username: 'bob' });
    const modal = await openSplit();
    expect(screen.queryByTestId('split-preview-creator')).toBeNull();
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 50 Buzz');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(api.__tips()).toHaveLength(1));
    expect(api.__tips()[0]).toMatchObject({ toUserId: CURATOR_ID, amount: 50 });
  });

  it('BOTH sides self: the split control is disabled and says why', async () => {
    // A collection the viewer curates, holding media the viewer created — the
    // only shape where there is genuinely nobody to pay.
    const mine: MediaItem = {
      mediaId: 7001,
      type: 'image',
      url: 'https://example.invalid/i/7001.jpg',
      width: 1024,
      height: 1024,
      creator: { userId: 99, username: 'me' },
      nsfwLevel: 1,
    };
    const seed: SeedCollection[] = [
      {
        summary: {
          id: 301,
          name: 'All Mine',
          description: null,
          coverImageUrl: mine.url,
          itemCount: 1,
          curator: { userId: 99, username: 'me' },
          isPublic: true,
          followed: false,
        },
        items: [mine],
      },
    ];
    const api = createFakeApi({ viewerUserId: 99, balance: 5000, collections: seed }) as FakeApi;
    await openFirst(api);
    const btn = screen.getByTestId('tip-split');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', "This is your own media in your own collection — there's no one to tip.");
    // The single-target controls are disabled for the same reason.
    expect(screen.getByTestId('tip-creator')).toBeDisabled();
    expect(screen.getByTestId('tip-curator')).toBeDisabled();
    expect(api.__tips()).toHaveLength(0);
  });
});

describe('the server allowance reaches the pickers (hazard 4)', () => {
  it('blocks a total over what the SERVER says is left today', async () => {
    // The server reports 25000 − 24700 = 300 remaining.
    const api = createFakeApi({ viewerUserId: 99, balance: 100000, tipSpentToday: 24700 }) as FakeApi;
    await openFirst(api);
    const modal = await openSplit();
    await waitFor(() => expect(screen.getByTestId('tip-split-allowance')).toHaveTextContent('Up to 300 Buzz in total.'));
    const input = within(modal).getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '400');
    // 400 splits to 200/200 — each leg is under 300, so only a check on the
    // TOTAL catches this.
    expect(await screen.findByTestId('split-error')).toHaveTextContent("Only 300 Buzz left in today's tip allowance.");
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    expect(api.__tips()).toHaveLength(0);
  });

  it('re-reads the allowance after a tip, so the next picker opens on the new figure', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 100000, tipSpentToday: 24000 }) as FakeApi;
    await openFirst(api);
    const modal = await openSplit();
    await waitFor(() => expect(screen.getByTestId('tip-split-allowance')).toHaveTextContent('Up to 1,000 Buzz in total.'));
    await userEvent.click(within(modal).getByTestId('split-confirm')); // 50, split 25/25
    await waitFor(() => expect(screen.queryByTestId('tip-split-modal')).toBeNull());
    // 25000 − 24000 − 50 = 950. The old localStorage estimate could never have
    // moved this number; the server read does.
    const reopened = await openSplit();
    await waitFor(() =>
      expect(within(reopened).getByTestId('tip-split-allowance')).toHaveTextContent('Up to 950 Buzz in total.'),
    );
  });

  it('🔴 a FAILED allowance read does not make tipping impossible', async () => {
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 }) as FakeApi;
    const api: ApiClient = {
      ...base,
      async getTipAllowance(): Promise<never> {
        throw new ApiError('network', 0, 'The request timed out.');
      },
    };
    await openFirst(api);
    const modal = await openSplit();
    // Falls back to the per-press cap, and the press still goes through.
    expect(screen.getByTestId('tip-split-allowance')).toHaveTextContent('Up to 5,000 Buzz in total.');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(base.__tips()).toHaveLength(2));
    expect(base.__balance()).toBe(4950);
  });
});
