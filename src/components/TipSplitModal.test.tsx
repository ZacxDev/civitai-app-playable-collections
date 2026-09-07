// The %-split popover, driven through its real DOM.
//
// Amounts asserted here are LITERALS. Recomputing a split inside an assertion
// with the same formula the component uses would pass for any formula.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TipSplitModal, splitTipKey, type PlannedLeg } from './TipSplitModal.js';
import type { TipTarget } from './TipModal.js';

const CREATOR: TipTarget = {
  kind: 'creator',
  toUserId: 22,
  username: 'bob',
  entityType: 'Image',
  entityId: 1001,
};
const CURATOR: TipTarget = {
  kind: 'curator',
  toUserId: 11,
  username: 'alice',
  entityType: 'Collection',
  entityId: 101,
};

/**
 * Render the popover with a deterministic key minter + a scripted leg sender.
 *
 * 🔴 THE PLAN IS OWNED BY THE HARNESS, NOT BY THE COMPONENT — that is the shape
 * production uses (App holds it, keyed by `splitTipKey`), and it is what lets
 * `mounted` be flipped to model the viewer pressing Close and reopening. A
 * harness that kept the plan inside the component could not express the
 * double-pay this file now guards.
 */
function setup(opts: {
  creator?: TipTarget | null;
  curator?: TipTarget | null;
  balance?: number | null;
  dailyRemaining?: number;
  send?: (target: TipTarget, amount: number, key: string) => Promise<boolean>;
} = {}) {
  const calls: Array<{ toUserId: number; amount: number; key: string }> = [];
  const send = vi.fn(async (target: TipTarget, amount: number, key: string) => {
    calls.push({ toUserId: target.toUserId, amount, key });
    return opts.send ? opts.send(target, amount, key) : true;
  });
  const onDone = vi.fn();
  const onClose = vi.fn();
  let n = 0;
  const newKey = vi.fn(() => `key-${++n}`);
  const creator = opts.creator === undefined ? CREATOR : opts.creator;
  const curator = opts.curator === undefined ? CURATOR : opts.curator;
  /** Flipped by `close()` / `reopen()` to unmount + remount the popover. */
  let setMounted: (v: boolean) => void = () => {};

  function Host() {
    const [plans, setPlans] = useState<Record<string, PlannedLeg[]>>({});
    const [mounted, setMountedState] = useState(true);
    setMounted = setMountedState;
    const key = splitTipKey(creator, curator);
    if (!mounted) return null;
    return (
      <TipSplitModal
        creator={creator}
        curator={curator}
        balance={opts.balance === undefined ? 100000 : opts.balance}
        submitting={false}
        dailyRemaining={opts.dailyRemaining}
        onSendLeg={send}
        onDone={onDone}
        onClose={onClose}
        plan={plans[key] ?? null}
        onPlanChange={(plan) =>
          setPlans((prev) => {
            if (plan == null) {
              const next = { ...prev };
              delete next[key];
              return next;
            }
            return { ...prev, [key]: plan };
          })
        }
        newKey={newKey}
      />
    );
  }

  render(<Host />);
  return {
    send,
    calls,
    onDone,
    onClose,
    newKey,
    /** The viewer presses Close: the component unmounts, the owner keeps the plan. */
    close: () => act(() => setMounted(false)),
    reopen: () => act(() => setMounted(true)),
  };
}

describe('the split preview — what each side gets, before confirming', () => {
  it('shows both recipients at the default even split of the default 50 Buzz', () => {
    setup();
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 25 Buzz');
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 25 Buzz');
  });

  it('re-splits when the percentage changes', async () => {
    setup();
    await userEvent.click(screen.getByTestId('split-preset-100'));
    await userEvent.click(screen.getByTestId('split-percent-75'));
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 75 Buzz');
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 25 Buzz');
  });

  it('shows the CLAMPED amounts, not the raw percentage (99/1 of 50 Buzz)', async () => {
    setup();
    await userEvent.click(screen.getByTestId('split-preset-50'));
    // 99% of 50 rounds to 50, which would leave the curator 0. The preview must
    // show what would ACTUALLY be sent: 49 and 1.
    // (`fireEvent.change` on the native range, not userEvent keyboard — jsdom has
    // no `setSelectionRange` for a range input and userEvent throws on it.)
    fireEvent.change(screen.getByTestId('split-percent'), { target: { value: '99' } });
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 49 Buzz');
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 1 Buzz');
  });

  it('a 0% slider position gives the curator the whole total, with no 0-Buzz creator leg', async () => {
    const { calls, onDone } = setup();
    fireEvent.change(screen.getByTestId('split-percent'), { target: { value: '0' } });
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 0 Buzz');
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 50 Buzz');
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // ONE transfer, for the whole 50 — never a second one carrying 0.
    expect(calls).toEqual([{ toUserId: 11, amount: 50, key: 'key-1' }]);
  });

  it('a 100% slider position gives the creator the whole total', async () => {
    const { calls, onDone } = setup();
    fireEvent.change(screen.getByTestId('split-percent'), { target: { value: '100' } });
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls).toEqual([{ toUserId: 22, amount: 50, key: 'key-1' }]);
  });

  it('surfaces the effective ceiling — min(per-press cap, remaining allowance)', () => {
    setup({ dailyRemaining: 300 });
    expect(screen.getByTestId('tip-split-allowance')).toHaveTextContent('Up to 300 Buzz in total.');
  });

  it('falls back to the 5,000 per-press cap when the allowance is unknown', () => {
    setup({ dailyRemaining: undefined });
    expect(screen.getByTestId('tip-split-allowance')).toHaveTextContent('Up to 5,000 Buzz in total.');
  });
});

describe('self-tip collapse (hazard 3)', () => {
  it('offers ONLY the curator when the viewer is the creator, and says why', () => {
    setup({ creator: null });
    expect(screen.queryByTestId('split-preview-creator')).toBeNull();
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 50 Buzz');
    // The whole total goes to the surviving side — not half of it.
    expect(screen.getByTestId('tip-split-modal')).toHaveTextContent('This is your media');
    // No split control at all: there is nothing to divide.
    expect(screen.queryByTestId('split-percent')).toBeNull();
  });

  it('offers ONLY the creator when the viewer is the curator', () => {
    setup({ curator: null });
    expect(screen.queryByTestId('split-preview-curator')).toBeNull();
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 50 Buzz');
    expect(screen.getByTestId('tip-split-modal')).toHaveTextContent('You curate this collection');
  });

  it('sends ONE leg for the whole total when a side has collapsed', async () => {
    const { send, calls, onDone } = setup({ creator: null });
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ toUserId: 11, amount: 50 });
  });
});

describe('client-side gates', () => {
  it('blocks a 5001 total and never calls the sender', async () => {
    const { send } = setup();
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '5001');
    expect(await screen.findByTestId('split-error')).toHaveTextContent('Maximum is 5,000 Buzz per tip in total.');
    expect(screen.getByTestId('split-confirm')).toBeDisabled();
    await userEvent.click(screen.getByTestId('split-confirm'));
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts a 5000 total (the boundary) and sends 2500 to each side', async () => {
    const { calls, onDone } = setup();
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '5000');
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls).toEqual([
      { toUserId: 22, amount: 2500, key: 'key-1' },
      { toUserId: 11, amount: 2500, key: 'key-2' },
    ]);
  });

  it('refuses a two-way split of 1 Buzz rather than sending a 0-Buzz leg', async () => {
    const { send } = setup();
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '1');
    expect(await screen.findByTestId('split-error')).toHaveTextContent('A split needs at least 2 Buzz — 1 for each side.');
    await userEvent.click(screen.getByTestId('split-confirm'));
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks a total over the remaining daily allowance (hazard 4: the TOTAL, not a leg)', async () => {
    // 400 splits to 200/200 — each leg is under 300, so a per-LEG allowance check
    // would let this through and overspend the day by 100.
    const { send } = setup({ dailyRemaining: 300 });
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '400');
    expect(await screen.findByTestId('split-error')).toHaveTextContent("Only 300 Buzz left in today's tip allowance.");
    await userEvent.click(screen.getByTestId('split-confirm'));
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks a total over the Buzz balance (hazard 5: the TOTAL, not a leg)', async () => {
    const { send } = setup({ balance: 300 });
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '400');
    expect(await screen.findByTestId('split-error')).toHaveTextContent("That's more than your 300 Buzz balance.");
    await userEvent.click(screen.getByTestId('split-confirm'));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('partial failure + retry (hazard 1)', () => {
  it('sends each leg under its OWN key', async () => {
    const { calls, onDone } = setup();
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls).toEqual([
      { toUserId: 22, amount: 25, key: 'key-1' },
      { toUserId: 11, amount: 25, key: 'key-2' },
    ]);
    expect(onDone).toHaveBeenCalledWith([
      { kind: 'creator', amount: 25 },
      { kind: 'curator', amount: 25 },
    ]);
  });

  it('🔴 a retry re-sends ONLY the outstanding leg, under the SAME key', async () => {
    let curatorAttempts = 0;
    const { calls, onDone } = setup({
      send: async (target) => {
        if (target.kind === 'curator') {
          curatorAttempts += 1;
          return curatorAttempts > 1; // fails once, then succeeds
        }
        return true;
      },
    });
    await userEvent.click(screen.getByTestId('split-confirm'));
    // The partial-failure panel names what landed and what did not.
    const partial = await screen.findByTestId('split-partial');
    expect(partial).toBeInTheDocument();
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    expect(screen.getByTestId('split-leg-curator')).toHaveAttribute('data-status', 'failed');
    expect(onDone).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('split-retry'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    // THREE sends in total, never four: the creator leg is not re-sent, and the
    // curator retry carries key-2 — the key the first attempt used.
    expect(calls).toEqual([
      { toUserId: 22, amount: 25, key: 'key-1' },
      { toUserId: 11, amount: 25, key: 'key-2' },
      { toUserId: 11, amount: 25, key: 'key-2' },
    ]);
    expect(calls.filter((c) => c.toUserId === 22)).toHaveLength(1);
  });

  it('locks the amount and the split once a plan exists', async () => {
    setup({ send: async (target) => target.kind !== 'curator' });
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    // The plan's keys are already at the server; a different amount under the same
    // key would ask for a transfer the server replays as the FIRST one.
    expect(screen.getByTestId('split-amount-input')).toBeDisabled();
    expect(screen.getByTestId('split-percent')).toBeDisabled();
    expect(screen.getByTestId('split-preset-100')).toBeDisabled();
  });

  it('sends an UNEVEN split with the exact per-recipient amounts (75/25)', async () => {
    // 🔴 EVERY OTHER SEND ASSERTION IN THIS ARC USES AN EVEN SPLIT (25/25,
    // 2500/2500), so a mutant that swaps the two legs' amounts — or divides the
    // total evenly regardless of the slider — is INVISIBLE to all of them. This
    // is the fixture that can see it: 75 and 25 are distinct from each other and
    // from the total.
    const { calls, onDone } = setup();
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '100');
    await userEvent.click(screen.getByTestId('split-percent-75'));
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 75 Buzz');
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 25 Buzz');

    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls).toEqual([
      { toUserId: 22, amount: 75, key: 'key-1' },
      { toUserId: 11, amount: 25, key: 'key-2' },
    ]);
    expect(onDone).toHaveBeenCalledWith([
      { kind: 'creator', amount: 75 },
      { kind: 'curator', amount: 25 },
    ]);
  });

  it('keeps failing legs retryable — a second failure re-shows the panel', async () => {
    const { calls, onDone } = setup({ send: async (target) => target.kind !== 'curator' });
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    await userEvent.click(screen.getByTestId('split-retry'));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(screen.getByTestId('split-partial')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    // Still only ONE creator transfer after two retries' worth of pressing.
    expect(calls.filter((c) => c.toUserId === 22)).toHaveLength(1);
  });
});

describe('🔴 the synchronous re-entrance guard (sendingRef) — no witness before this', () => {
  /** A sender that parks, so the in-flight window can be inspected and re-entered. */
  function parkedSender() {
    const released: Array<(ok: boolean) => void> = [];
    const send = (_t: TipTarget, _a: number, _k: string) =>
      new Promise<boolean>((resolve) => released.push(resolve));
    return { send, releaseAll: (ok = true) => released.splice(0).forEach((r) => r(ok)) };
  }

  it('a DOUBLE CONFIRM in one tick mints ONE set of keys, not two', async () => {
    // `setSending(true)` only disables the button on the NEXT render, so both
    // clicks of a fast double-click reach `confirm()`. Without the guard the
    // second one mints a fresh pair of keys and hands them to the owner OVER the
    // plan that is already being sent — after which a retry would be sending
    // legs the server has never seen under keys nothing can replay.
    const parked = parkedSender();
    const { calls, newKey } = setup({ send: parked.send });
    const btn = screen.getByTestId('split-confirm');
    act(() => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(newKey).toHaveBeenCalledTimes(2); // one per LEG, of ONE plan
    expect(calls.map((c) => c.key)).toEqual(['key-1']); // leg 2 waits on leg 1
    await act(async () => parked.releaseAll(true));
    expect(calls.map((c) => c.key)).toEqual(['key-1', 'key-2']);
  });

  it('a DOUBLE RETRY in one tick runs the plan once, not twice', async () => {
    const { calls } = setup({ send: async (target) => target.kind !== 'curator' });
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    expect(calls).toHaveLength(2);

    const retry = screen.getByTestId('split-retry');
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await waitFor(() => expect(calls).toHaveLength(3));
    // Exactly ONE extra attempt. Two concurrent loops over the same plan would
    // put the outstanding leg on the wire twice.
    expect(calls).toHaveLength(3);
    expect(calls.filter((c) => c.toUserId === 22)).toHaveLength(1);
  });

  it('🔴 cannot be DISMISSED while a leg is on the wire', async () => {
    // Escape, an overlay click and the × all close the shell, and none of them
    // cancel the POST already in flight — so a dismissal mid-send spends the Buzz
    // and takes the partial-failure UI (and the retry, and the plan) away.
    const parked = parkedSender();
    // ONE leg, so a single release ends the in-flight window cleanly (with two
    // legs, releasing the first immediately parks the second).
    const { onClose } = setup({ creator: null, send: parked.send });
    // Positive control: BEFORE the send, all three dismiss affordances are live —
    // otherwise their absence below would prove nothing.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument(); // the ×
    expect(screen.getByTestId('split-cancel')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('split-confirm'));

    expect(screen.getByTestId('split-cancel')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull(); // the × is gone
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    // …and it becomes dismissible again the moment the wire is clear.
    await act(async () => parked.releaseAll(false));
    expect(screen.getByTestId('split-cancel')).not.toBeDisabled();
  });
});

describe('splitTipKey — the identity a resumed plan is stored under', () => {
  it('distinguishes the ENTITIES, not just the people', () => {
    // A plan is resumed by key, and a resumed plan replays keys the server has
    // already terminal-ised. Two DIFFERENT images by the same creator in the same
    // collection are two different tips: sharing a key would make the second
    // press replay the first press's transfer and silently send nothing.
    const base = splitTipKey(CREATOR, CURATOR);
    expect(splitTipKey({ ...CREATOR, entityId: 1002 }, CURATOR)).not.toBe(base);
    expect(splitTipKey(CREATOR, { ...CURATOR, entityId: 102 })).not.toBe(base);
    expect(splitTipKey({ ...CREATOR, toUserId: 999 }, CURATOR)).not.toBe(base);
    expect(splitTipKey(null, CURATOR)).not.toBe(base);
    expect(splitTipKey(CREATOR, null)).not.toBe(base);
    // …and is stable for the same logical tip, or nothing would ever resume.
    expect(splitTipKey({ ...CREATOR }, { ...CURATOR })).toBe(base);
  });
});

describe('🔴 the plan OUTLIVES this component (the close → reopen double-pay)', () => {
  it('resumes the same plan, with the landed leg still marked sent and its key intact', async () => {
    let curatorAttempts = 0;
    const { calls, close, reopen, onDone } = setup({
      send: async (target) => {
        if (target.kind === 'curator') return ++curatorAttempts > 1;
        return true;
      },
    });
    // 🔴 DELIBERATELY NOT THE DEFAULTS. A resumed plan of 50 split 25/25 is
    // indistinguishable from a BLANK form (default total 50, default split 50%),
    // so every assertion below would pass on a popover that resumed nothing. 100
    // at 75/25 makes the total, both leg amounts and the split all differ from
    // the constants the component falls back to.
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '100');
    await userEvent.click(screen.getByTestId('split-percent-75'));
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');

    // The viewer presses **Close** — the label this component itself shows in the
    // failed state, right beside the promise below.
    close();
    expect(screen.queryByTestId('tip-split-modal')).toBeNull();
    reopen();

    // Not a blank form: the same two legs, the same statuses, a Retry.
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    expect(screen.getByTestId('split-leg-curator')).toHaveAttribute('data-status', 'failed');
    expect(screen.queryByTestId('split-confirm')).toBeNull();
    // The locked amount and the split survive too — showing the defaults here
    // would put numbers on screen that are not the ones the keys were minted for.
    expect(screen.getByTestId('split-amount-input')).toHaveValue('100');
    expect(screen.getByTestId('split-preview-creator')).toHaveTextContent('@bob (creator): 75 Buzz');
    expect(screen.getByTestId('split-preview-curator')).toHaveTextContent('@alice (curator): 25 Buzz');

    await userEvent.click(screen.getByTestId('split-retry'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // 🔴 THREE sends across the whole sequence, never four: the creator leg is
    // not re-sent, and the curator's retry carries key-2 with its ORIGINAL amount.
    expect(calls).toEqual([
      { toUserId: 22, amount: 75, key: 'key-1' },
      { toUserId: 11, amount: 25, key: 'key-2' },
      { toUserId: 11, amount: 25, key: 'key-2' },
    ]);
  });

  it('offers no discard while the plan is only PARTLY failed — replay is the only safe move there', async () => {
    // 🔴 THE OTHER HALF OF THE ESCAPE HATCH BELOW, AND THE ONE THAT KEEPS IT
    // FROM BEING THE EASY DEFAULT. With a leg already `sent`, discarding the
    // plan and starting over mints fresh keys and re-sends that leg — the exact
    // double-pay the plan exists to prevent. So here there is Retry and nothing
    // else; the affordance is ABSENT, not merely disabled.
    // (Its positive control is the next test, where the same testid IS present.)
    const { close, reopen } = setup({ send: async (target) => target.kind !== 'curator' });
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
    expect(screen.getByTestId('split-leg-curator')).toHaveAttribute('data-status', 'failed');

    expect(screen.getByTestId('split-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('split-discard')).toBeNull();

    // …and it does not appear on a reopen either.
    close();
    reopen();
    expect(screen.getByTestId('split-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('split-discard')).toBeNull();
  });

  it('🔴 a FULLY-failed plan can be DISCARDED, and the picker comes back usable at a NEW amount', async () => {
    // Every leg refused (a 403, a burst rate-limit, a network failure at an
    // unknown balance) used to leave the viewer with: the amount input disabled
    // and pinned to the original, the presets disabled, no Confirm, and a Retry
    // that can only ever re-send the SAME amount. No discard, no reset — a page
    // reload was the only way to tip this media a different number of Buzz.
    //
    // 🔴 THE PLAN IS NOT AUTO-RETIRED. A "failed" leg may be one whose response
    // was merely LOST, so its key is still worth replaying; discarding it
    // silently is how a recoverable state becomes a double-spend. The viewer
    // chooses, and the copy tells them what the choice costs.
    let attempt = 0;
    const { calls, onDone, close, reopen } = setup({
      send: async () => {
        attempt += 1;
        return attempt > 2; // the first press's two legs both refuse
      },
    });
    const input = screen.getByTestId('split-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '100');
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('split-leg-curator')).toHaveAttribute('data-status', 'failed');

    // The locked state the viewer is stuck in, and it survives close → reopen.
    close();
    reopen();
    expect(screen.getByTestId('split-amount-input')).toBeDisabled();
    expect(screen.getByTestId('split-amount-input')).toHaveValue('100');
    expect(screen.queryByTestId('split-confirm')).toBeNull();

    // Retry stays the primary action; the discard is the secondary escape …
    expect(screen.getByTestId('split-retry')).toBeInTheDocument();
    // … and it is HONEST about the trade rather than silent about it.
    const note = screen.getByTestId('split-discard-note').textContent?.replace(/\s+/g, ' ') ?? '';
    expect(note).toMatch(/retry/i);
    expect(note).toMatch(/second transfer/i);

    await userEvent.click(screen.getByTestId('split-discard'));

    // A fresh picker: nothing locked, no failure panel, a live Send.
    expect(screen.queryByTestId('split-partial')).toBeNull();
    expect(screen.queryByTestId('split-discard')).toBeNull();
    const fresh = screen.getByTestId('split-amount-input');
    expect(fresh).not.toBeDisabled();
    expect(screen.getByTestId('split-preset-100')).not.toBeDisabled();

    // …usable at a DIFFERENT amount, under keys the server has never seen.
    await userEvent.clear(fresh);
    await userEvent.type(fresh, '10');
    await userEvent.click(screen.getByTestId('split-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls).toEqual([
      { toUserId: 22, amount: 50, key: 'key-1' },
      { toUserId: 11, amount: 50, key: 'key-2' },
      { toUserId: 22, amount: 5, key: 'key-3' },
      { toUserId: 11, amount: 5, key: 'key-4' },
    ]);
  });

  it('cannot discard a plan whose retry is already on the wire', async () => {
    // The discard is a plan mutation like any other, so it carries the same TWO
    // gates the confirm does, and both are separately reachable.
    let park = false;
    const parked: Array<(ok: boolean) => void> = [];
    setup({
      send: () => (park ? new Promise<boolean>((r) => parked.push(r)) : Promise.resolve(false)),
    });
    // An all-failed plan, settled: both buttons live.
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    expect(screen.getByTestId('split-discard')).not.toBeDisabled();
    expect(screen.getByTestId('split-retry')).not.toBeDisabled();

    // GATE 1 — the same tick. `setSending(true)` only disables the button on the
    // NEXT render, so a discard click landing in the same tick as the Retry
    // press still sees an ENABLED button. Without the synchronous ref check that
    // click retires the plan out from under the legs being re-sent right now,
    // throwing away the very keys that make the replay safe.
    park = true;
    act(() => {
      fireEvent.click(screen.getByTestId('split-retry'));
      fireEvent.click(screen.getByTestId('split-discard'));
    });
    expect(screen.getByTestId('split-partial')).toBeInTheDocument();
    expect(screen.getByTestId('split-leg-creator')).toBeInTheDocument();

    // GATE 2 — the rendered state, now that React has caught up.
    expect(screen.getByTestId('split-discard')).toBeDisabled();

    // Drain the retry (both legs refuse again) and the escape hatch returns.
    await act(async () => parked.splice(0).forEach((r) => r(false)));
    await waitFor(() => expect(parked).toHaveLength(1));
    await act(async () => parked.splice(0).forEach((r) => r(false)));
    await screen.findByTestId('split-partial');
    expect(screen.getByTestId('split-discard')).not.toBeDisabled();
  });

  it('pins the partial-failure promise VERBATIM against the behaviour it describes', async () => {
    // 🔴 THE WHOLE NORMALISED STRING, NOT A KEYWORD. A guard on words is walkable
    // by rewording, and this sentence is the one the arc keeps getting wrong: it
    // promised that already-sent parts could not be sent twice while the button
    // beside it destroyed the plan that made that true. Changing the copy must
    // cost a deliberate edit here, next to the test that proves the claim.
    const { close, reopen } = setup({ send: async (target) => target.kind !== 'curator' });
    await userEvent.click(screen.getByTestId('split-confirm'));
    await screen.findByTestId('split-partial');
    const promise = screen.getByTestId('split-partial-promise').textContent?.replace(/\s+/g, ' ').trim();
    expect(promise).toBe(
      'Retrying sends only what is still outstanding — the part already sent cannot be sent twice. ' +
        'Closing is safe too: reopening this split picks the same tip back up, for as long as this page stays open.',
    );
    // The second sentence, executed: close, reopen, and the tip is still there.
    close();
    reopen();
    expect(screen.getByTestId('split-leg-creator')).toHaveAttribute('data-status', 'sent');
  });
});
