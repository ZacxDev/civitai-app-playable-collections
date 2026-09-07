// The %-split popover, driven through its real DOM.
//
// Amounts asserted here are LITERALS. Recomputing a split inside an assertion
// with the same formula the component uses would pass for any formula.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TipSplitModal } from './TipSplitModal.js';
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

/** Render the popover with a deterministic key minter + a scripted leg sender. */
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
  render(
    <TipSplitModal
      creator={opts.creator === undefined ? CREATOR : opts.creator}
      curator={opts.curator === undefined ? CURATOR : opts.curator}
      balance={opts.balance === undefined ? 100000 : opts.balance}
      submitting={false}
      dailyRemaining={opts.dailyRemaining}
      onSendLeg={send}
      onDone={onDone}
      onClose={onClose}
      newKey={() => `key-${++n}`}
    />,
  );
  return { send, calls, onDone, onClose };
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
