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
      {/* The Harness token carries no `social:tip:self`, so without this the T5 consent
          gate short-circuits every tip case in this file into a REQUEST_CONSENT. These
          suites are about the money MECHANICS, not about consent — the gate has its own
          red/green pair in `components/tip-affordance.test.tsx`. */}
      <App api={api} isTipGranted={() => true} />
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
    // 0.2.14: the Player no longer owns an exit. In classic mode the themed
    // toolbar's `viewer-exit` is the only back affordance — the duplicate
    // white-on-media overlay was removed. The BEHAVIOUR asserted here (exit
    // returns to the grid) is unchanged; only the control moved.
    await userEvent.click(screen.getByTestId('viewer-exit'));
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

// ---------------------------------------------------------------------------
// Tipping, through the ONE consolidated affordance (T5).
//
// 🔴 EVERY CASE BELOW USED TO PRESS `tip-creator` AND CONFIRM IN `tip-modal`.
// Those two controls are gone: there is one `chrome-tip` button opening one
// picker, and the DESTINATION is chosen inside it. The money assertions are
// unchanged — same recipient, same amount, same ledger — only the route is.
//
// ⚠️ ONE ASSERTION COULD NOT COME ACROSS AND IS NOT QUIETLY RESTATED: the
// optimistic "Tipped creator" glyph state. It lived on the per-target rail
// button, and with one button serving three destinations there is no per-target
// control left to mark. The success toast (asserted here) is the surviving
// confirmation. Recorded as a behaviour change rather than dropped in silence.
// ---------------------------------------------------------------------------

/** Open the one picker and choose a destination. */
async function openTip(target: 'creator' | 'curator' | 'split' = 'split') {
  await userEvent.click(screen.getByTestId('chrome-tip'));
  const modal = await screen.findByTestId('tip-split-modal');
  const chip = within(modal).queryByTestId(`tip-target-${target}`);
  if (chip) await userEvent.click(chip);
  return modal;
}

describe('tip flow', () => {
  it('tips the creator: one transfer, balance decrement, success toast', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 5000 }) as FakeApi;
    await openNeon(api);
    // First item creator is bob (22) — not the viewer — so tipping is allowed.
    const modal = await openTip('creator');
    // default preset amount is 50
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    await waitFor(() => expect(api.__tips()).toHaveLength(1));
    expect(api.__tips()[0]).toMatchObject({ toUserId: 22, amount: 50, entityType: 'Image' });
    expect(api.__balance()).toBe(4950);
    expect(await screen.findByTestId('toast-success')).toBeInTheDocument();
  });

  it('the ONE control stays usable when only ONE side has collapsed', async () => {
    // viewer is bob (22); first item creator is bob (22) => the creator side
    // collapses, but alice still curates, so a tip is still possible. This is
    // the behaviour change the consolidation buys: the old `tip-creator` button
    // was simply disabled here and the viewer had to find a different button.
    const api = createFakeApi({ viewerUserId: 22 });
    await openNeon(api, { id: 22, username: 'bob' });
    expect(screen.getByTestId('chrome-tip')).not.toBeDisabled();
    const modal = await openTip();
    expect(within(modal).getByTestId('split-preview-curator')).toHaveTextContent('(curator): 50 Buzz');
    expect(within(modal).queryByTestId('split-preview-creator')).toBeNull();
  });

  it('validates the tip amount (0 is rejected)', async () => {
    const api = createFakeApi({ viewerUserId: 99 });
    await openNeon(api);
    const modal = await openTip('creator');
    const input = within(modal).getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '0');
    expect(await screen.findByTestId('split-error')).toBeInTheDocument();
    expect(within(modal).getByTestId('split-confirm')).toBeDisabled();
  });

  it('surfaces insufficient balance as a clean toast and leaves the picker up', async () => {
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
    const modal = await openTip('creator');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    expect(await screen.findByTestId('toast-error')).toHaveTextContent(/enough Buzz/i);
    // The picker stays up, carrying the failed plan and its retry.
    expect(screen.getByTestId('tip-split-modal')).toBeInTheDocument();
    await screen.findByTestId('split-partial');
  });
});

describe('tip caps + rate limiting (ship-blocker #2)', () => {
  it('surfaces the server Retry-After on a rate-limited tip', async () => {
    const api = createFakeApi({ viewerUserId: 99, failMode: 'rate_limited' });
    await openNeon(api);
    const modal = await openTip('creator');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    // The fake throws rate_limited with retryAfterMs 2000 → surfaced as "2s".
    expect(await screen.findByTestId('toast-error')).toHaveTextContent(/try again in 2s/);
  });

  it('treats a non-throwing { ok: false } tip as a failure (no success toast)', async () => {
    const base = createFakeApi({ viewerUserId: 99, balance: 5000 });
    const api: ApiClient = { ...base, async tip() { return { ok: false }; } };
    await openNeon(api);
    const modal = await openTip('creator');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
    expect(await screen.findByTestId('toast-error')).toBeInTheDocument();
    expect(screen.queryByTestId('toast-success')).toBeNull();
  });

  it('shows the effective per-press ceiling in the picker (no untracked daily figure)', async () => {
    const api = createFakeApi({ viewerUserId: 99, balance: 100000 }) as FakeApi;
    await openNeon(api);
    const modal = await openTip('creator');
    const allowance = within(modal).getByTestId('tip-split-allowance');
    expect(allowance).toHaveTextContent('Up to 5,000 Buzz in total.');
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
    const modal = await openTip('creator');
    const confirm = within(modal).getByTestId('split-confirm');
    // TWO clicks in one tick — before `setSending(true)`'s re-render can disable
    // the button. Only the synchronous re-entrance gates stop the 2nd POST.
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
    const modal = await openTip('creator');
    await userEvent.click(within(modal).getByTestId('split-confirm'));
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
    const modal = await openTip('creator');
    await userEvent.click(within(modal).getByTestId('split-confirm')); // client default 50
    // The success toast reflects the SERVER figure (40), never the requested 50.
    const toast = await screen.findByTestId('toast-success');
    expect(toast).toHaveTextContent('40');
    expect(toast).not.toHaveTextContent('50');
  });
});

// ---------------------------------------------------------------------------
// FOLLOW — one control, upstream `FollowButton`, driven through the MOCK HOST.
//
// 🔴 THE REFUSAL PATHS ARE THE POINT (T5 criterion 7), AND THEY ARE HOST-SIDE.
// Following does not touch the injected `ApiClient` at all, so a throwing fake
// cannot reach them; `collectionFollowError` on the Harness is what makes the
// host refuse. Read `chrome-follow-note` — upstream composes the note's testid
// as `${testid}-note`, so it appears nowhere in this repo as a literal.
// ---------------------------------------------------------------------------

describe('follow toggle — one control, host-mediated', () => {
  it('follows through the HOST BRIDGE and adopts the echo', async () => {
    // 🔴 THIS USED TO ASSERT `api.__isFollowed(101)` AND THAT OBSERVABLE IS GONE
    // ON PURPOSE. The fake ApiClient's follow map was the old HTTP path's
    // server-side state; a bridge follow never touches the injected client, so
    // the map stays false forever and the old assertion would fail against a
    // perfectly working feature.
    const api = createFakeApi({ viewerUserId: 99 }) as FakeApi;
    await openNeon(api);
    const btn = screen.getByTestId('chrome-follow');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId('chrome-follow')).toHaveAttribute('aria-pressed', 'true'));
    // The fake client is NOT the path any more — pin that, so a silent
    // regression back to the HTTP follow fails here instead of shipping.
    expect(api.__isFollowed(101)).toBe(false);
  });

  it('🔴 a successful follow DROPS THE CACHED READS — the seam nobody owned', async () => {
    // 🔴 RETARGETED, NOT REWRITTEN, AND IT SHOULD NEVER HAVE BEEN AT RISK. This
    // guard was written for the retired `follow-toggle` rail button; consolidating
    // onto `chrome-follow` would have deleted it with the rail, and the PR nearly
    // shipped without it. `App.tsx`'s own comment claims "the invalidation on a
    // CONFIRMED follow is untouched" — this is the only thing in the repo that
    // makes that a checkable claim rather than a sentence.
    //
    // Why it matters: `followed` is embedded in the cached list AND detail
    // payloads, and following does not go through the client at all, so nothing
    // else drops them. Without this, re-opening the collection inside the
    // 5-minute TTL shows the pre-follow flag and the grid badge disagrees with the
    // button. `cache.test.ts` tests the WRAPPER in isolation; only this asserts
    // that App actually calls it.
    const invalidateReads = vi.fn();
    const api = { ...createFakeApi({ viewerUserId: 99 }), invalidateReads } as unknown as ApiClient;
    await openNeon(api);
    expect(invalidateReads).not.toHaveBeenCalled(); // control: not fired by merely opening
    await userEvent.click(screen.getByTestId('chrome-follow'));
    await waitFor(() => expect(invalidateReads).toHaveBeenCalledTimes(1));
  });

  it('unfollows again, adopting the echo both ways', async () => {
    const api = createFakeApi({ viewerUserId: 99 }) as FakeApi;
    await openNeon(api);
    await userEvent.click(screen.getByTestId('chrome-follow'));
    await waitFor(() => expect(screen.getByTestId('chrome-follow')).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(screen.getByTestId('chrome-follow'));
    await waitFor(() => expect(screen.getByTestId('chrome-follow')).toHaveAttribute('aria-pressed', 'false'));
  });

  it('🔴 a SERVER REFUSAL renders a message, never a raw code, and reverts the flip', async () => {
    // ⚠️ WHAT THIS DOES AND DOES NOT SHOW, STATED PLAINLY. Criterion 7 asks that
    // "a server message renders as itself". Upstream `FollowButton` renders its
    // OWN sentence for every rejection that is not `declined` /
    // `sign-in-required` — it does not forward the host's text. So the property
    // that actually holds, and that this pins, is: a refusal produces a
    // VIEWER-FACING SENTENCE (never the bare code string, which is what a
    // hand-rolled control shows for four of the six codes), announced with
    // `role="alert"`, and the optimistic flip is reverted.
    await openNeon(createFakeApi({ viewerUserId: 99 }), { id: 99, username: 'me' }, {
      collectionFollowError: 'collection-unavailable',
    });
    await userEvent.click(screen.getByTestId('chrome-follow'));
    const note = await screen.findByTestId('chrome-follow-note');
    expect(note).toHaveAttribute('role', 'alert');
    expect(note.textContent ?? '').not.toBe('collection-unavailable');
    expect((note.textContent ?? '').trim().length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByTestId('chrome-follow')).toHaveAttribute('aria-pressed', 'false'));
  });

  it('🔴 a DECLINED follow renders NOTHING — the viewer chose no, the app did not fail', async () => {
    // The single most important behaviour of this control. Every press opens a
    // host consent dialog, and dismissing it rejects with `declined`. A
    // hand-rolled button that renders every rejection tells someone who declined
    // that the app failed — which reads as a broken consent prompt.
    await openNeon(createFakeApi({ viewerUserId: 99 }), { id: 99, username: 'me' }, {
      collectionFollowError: 'declined',
    });
    await userEvent.click(screen.getByTestId('chrome-follow'));
    await waitFor(() => expect(screen.getByTestId('chrome-follow')).toHaveAttribute('aria-pressed', 'false'));
    // 🔴 NOTHING at all: no note, no toast of either kind.
    expect(screen.queryByTestId('chrome-follow-note')).toBeNull();
    expect(screen.queryByTestId('toast-error')).toBeNull();
    expect(screen.queryByTestId('toast-success')).toBeNull();
  });

  it('🔴 sign-in-required ROUTES TO SIGN-IN — and that is asserted on the wire', async () => {
    // 🔴 THE OUTBOUND MESSAGE, NOT "no error toast". The old test asserted only
    // that nothing bad rendered, which is equally true of a control that does
    // NOTHING at all — the reassuring-zero shape. `onOutbound` is the mock host's
    // interception hook, so this reads the actual REQUEST_SIGN_IN going up.
    const outbound: string[] = [];
    await openNeon(createFakeApi({ viewerUserId: 99 }), { id: 99, username: 'me' }, {
      collectionFollowError: 'sign-in-required',
      onOutbound: (m) => void outbound.push(m.type),
    });
    // Control: opening the collection has NOT asked for a sign-in.
    expect(outbound).not.toContain('REQUEST_SIGN_IN');

    await userEvent.click(screen.getByTestId('chrome-follow'));
    await waitFor(() => expect(outbound).toContain('REQUEST_SIGN_IN'));
    expect(screen.queryByTestId('chrome-follow-note')).toBeNull();
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
    // 0.2.14: the Player no longer owns an exit. In classic mode the themed
    // toolbar's `viewer-exit` is the only back affordance — the duplicate
    // white-on-media overlay was removed. The BEHAVIOUR asserted here (exit
    // returns to the grid) is unchanged; only the control moved.
    await userEvent.click(screen.getByTestId('viewer-exit'));
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
        {/* The Harness token carries no `social:tip:self`, so without this the T5 consent
          gate short-circuits every tip case in this file into a REQUEST_CONSENT. These
          suites are about the money MECHANICS, not about consent — the gate has its own
          red/green pair in `components/tip-affordance.test.tsx`. */}
      <App api={api} isTipGranted={() => true} />
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
