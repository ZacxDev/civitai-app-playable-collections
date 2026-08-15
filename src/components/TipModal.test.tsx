import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TipModal, validateTipAmount, type TipTarget } from './TipModal.js';

const target: TipTarget = {
  kind: 'creator',
  toUserId: 22,
  username: 'bob',
  entityType: 'Image',
  entityId: 1001,
};

describe('validateTipAmount', () => {
  it('accepts an amount at the 5000 per-tip cap', () => {
    expect(validateTipAmount('5000', 100000)).toBeNull();
  });

  it('rejects an amount over the 5000 per-tip cap (server BLOCK_TIP_MAX_PER_TIP)', () => {
    expect(validateTipAmount('5001', 100000)).toMatch(/5,000 Buzz per tip/);
    // The old client cap (100000) must NOT be accepted.
    expect(validateTipAmount('100000', 1000000)).toMatch(/per tip/);
  });

  it('rejects an amount over the remaining daily allowance', () => {
    expect(validateTipAmount('600', 100000, 500)).toMatch(/500 Buzz left in today/);
  });

  it('rejects more than the balance', () => {
    expect(validateTipAmount('400', 300)).toMatch(/Buzz balance/);
  });

  it('rejects blanks and non-integers', () => {
    expect(validateTipAmount('', 5000)).toMatch(/Enter an amount/);
    expect(validateTipAmount('1.5', 5000)).toMatch(/whole number/);
    expect(validateTipAmount('0', 5000)).toMatch(/Minimum/);
  });
});

describe('TipModal — per-tip cap readout', () => {
  it('surfaces the real per-tip cap and NOT the untracked daily figure (audit O1)', () => {
    render(<TipModal target={target} balance={100000} submitting={false} onConfirm={() => {}} onClose={() => {}} dailyRemaining={25000} />);
    const allowance = screen.getByTestId('tip-allowance');
    expect(allowance).toHaveTextContent('Up to 5,000 Buzz per tip');
    // The former "of 25,000 left today" framing is GONE — it was inert in the
    // opaque-origin sandbox (localStorage throws) and tracked nothing.
    expect(allowance).not.toHaveTextContent(/left today/i);
  });

  it('does NOT present a daily count even when a low dailyRemaining is passed (audit O1)', () => {
    // A low daily-remaining used to clamp + display a number derived from the
    // untracked app-local estimate. The readout now shows only the fixed per-tip
    // cap; the server rate limit is the real daily gate.
    render(<TipModal target={target} balance={100000} submitting={false} onConfirm={() => {}} onClose={() => {}} dailyRemaining={300} />);
    const allowance = screen.getByTestId('tip-allowance');
    expect(allowance).toHaveTextContent('Up to 5,000 Buzz per tip');
    expect(allowance).not.toHaveTextContent(/left today/i);
    expect(allowance).not.toHaveTextContent('300');
  });

  it('disables the confirm button while submitting (no double-spend on double-click)', () => {
    const onConfirm = vi.fn();
    render(<TipModal target={target} balance={100000} submitting onConfirm={onConfirm} onClose={() => {}} />);
    expect(screen.getByTestId('tip-confirm')).toBeDisabled();
  });

  it('blocks an over-cap amount client-side (confirm disabled, no onConfirm)', async () => {
    const onConfirm = vi.fn();
    render(<TipModal target={target} balance={100000} submitting={false} onConfirm={onConfirm} onClose={() => {}} />);
    const input = screen.getByTestId('tip-amount-input');
    await userEvent.clear(input);
    await userEvent.type(input, '6000');
    expect(await screen.findByTestId('tip-error')).toHaveTextContent(/per tip/);
    expect(screen.getByTestId('tip-confirm')).toBeDisabled();
    // Even clicking (defensive) does not fire onConfirm.
    await userEvent.click(screen.getByTestId('tip-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
