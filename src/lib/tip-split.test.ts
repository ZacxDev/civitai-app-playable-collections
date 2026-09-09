// The %-split money math. Every expectation below is a LITERAL — never the
// formula the implementation uses, which would pass for any formula.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CREATOR_PERCENT,
  RECIPIENT_PERCENT,
  TIP_MIN,
  TIP_TOTAL_MAX,
  newIdempotencyKey,
  recipientChoice,
  splitTipTotal,
  validateTipSplit,
  type TipRecipientChoice,
} from './tip-split.js';

const BOTH = { creatorEligible: true, curatorEligible: true };
const CURATOR_ONLY = { creatorEligible: false, curatorEligible: true };
const CREATOR_ONLY = { creatorEligible: true, curatorEligible: false };
const NEITHER = { creatorEligible: false, curatorEligible: false };

describe('the total cap is on the SUM, not per leg', () => {
  it('TIP_TOTAL_MAX is 5000 — the figure the store description promises "in total"', () => {
    expect(TIP_TOTAL_MAX).toBe(5000);
  });

  it('a 50/50 split of exactly 5000 is allowed and sums to 5000', () => {
    expect(validateTipSplit('5000', 100000, 50, BOTH)).toBeNull();
    expect(splitTipTotal(5000, 50, BOTH)).toEqual([
      { kind: 'creator', amount: 2500 },
      { kind: 'curator', amount: 2500 },
    ]);
  });

  it('5001 in total is refused even though NEITHER leg would exceed the server per-tip cap', () => {
    // 🔴 The hazard in one case: 2501 + 2500 clears the server's 5000-per-TRANSFER
    // gate twice over, and would spend 5001 from one press.
    expect(validateTipSplit('5001', 100000, 50, BOTH)).toBe('Maximum is 5,000 Buzz per tip in total.');
  });

  it('refuses a 10000 total outright (the un-capped two-leg maximum)', () => {
    expect(validateTipSplit('10000', 100000, 50, BOTH)).toBe('Maximum is 5,000 Buzz per tip in total.');
  });
});

describe('the split itself', () => {
  it('defaults to an even split', () => {
    expect(DEFAULT_CREATOR_PERCENT).toBe(50);
    expect(splitTipTotal(100, 50, BOTH)).toEqual([
      { kind: 'creator', amount: 50 },
      { kind: 'curator', amount: 50 },
    ]);
  });

  it('divides 100 Buzz 75/25', () => {
    expect(splitTipTotal(100, 75, BOTH)).toEqual([
      { kind: 'creator', amount: 75 },
      { kind: 'curator', amount: 25 },
    ]);
  });

  it('always sums to exactly the requested total, including at an odd total', () => {
    const legs = splitTipTotal(101, 50, BOTH);
    expect(legs).toEqual([
      { kind: 'creator', amount: 51 },
      { kind: 'curator', amount: 50 },
    ]);
    expect(legs[0].amount + legs[1].amount).toBe(101);
  });

  it('a 100/0 split is ONE leg carrying the whole total — no 0-Buzz companion', () => {
    expect(splitTipTotal(500, 100, BOTH)).toEqual([{ kind: 'creator', amount: 500 }]);
  });

  it('a 0/100 split is ONE leg to the curator', () => {
    expect(splitTipTotal(500, 0, BOTH)).toEqual([{ kind: 'curator', amount: 500 }]);
  });
});

describe('the per-leg minimum', () => {
  it('TIP_MIN is 1', () => {
    expect(TIP_MIN).toBe(1);
  });

  it('a 99/1 split of 50 Buzz gives the small side 1, not 0 (the operator case)', () => {
    // Unclamped this rounds to 50/0 — Math.round(49.5) is 50 — and the curator
    // leg would be a 0-Buzz transfer the server rejects.
    expect(splitTipTotal(50, 99, BOTH)).toEqual([
      { kind: 'creator', amount: 49 },
      { kind: 'curator', amount: 1 },
    ]);
  });

  it('a 97/3 split of 10 Buzz gives the small side 1, not 0', () => {
    // Unclamped: round(9.7) = 10, leaving 0.
    expect(splitTipTotal(10, 97, BOTH)).toEqual([
      { kind: 'creator', amount: 9 },
      { kind: 'curator', amount: 1 },
    ]);
  });

  it('clamps the CREATOR side up too (a 3/97 split of 10 Buzz)', () => {
    // round(0.3) = 0 for the creator; the clamp raises it and the curator absorbs it.
    expect(splitTipTotal(10, 3, BOTH)).toEqual([
      { kind: 'creator', amount: 1 },
      { kind: 'curator', amount: 9 },
    ]);
  });

  it('2 Buzz is the smallest splittable total: 1 and 1', () => {
    expect(splitTipTotal(2, 50, BOTH)).toEqual([
      { kind: 'creator', amount: 1 },
      { kind: 'curator', amount: 1 },
    ]);
    expect(validateTipSplit('2', 100000, 50, BOTH)).toBeNull();
  });

  it('1 Buzz cannot be split two ways — it is REFUSED, not rounded to a 0 leg', () => {
    expect(splitTipTotal(1, 50, BOTH)).toEqual([]);
    expect(validateTipSplit('1', 100000, 50, BOTH)).toBe('A split needs at least 2 Buzz — 1 for each side.');
  });

  it('1 Buzz to a SINGLE recipient is fine — the floor is per leg, not per press', () => {
    expect(splitTipTotal(1, 100, BOTH)).toEqual([{ kind: 'creator', amount: 1 }]);
    expect(validateTipSplit('1', 100000, 100, BOTH)).toBeNull();
  });
});

describe('self-tip collapse', () => {
  it('gives the WHOLE total to the curator when the viewer is the creator', () => {
    expect(splitTipTotal(300, 50, CURATOR_ONLY)).toEqual([{ kind: 'curator', amount: 300 }]);
  });

  it('gives the WHOLE total to the creator when the viewer is the curator', () => {
    expect(splitTipTotal(300, 50, CREATOR_ONLY)).toEqual([{ kind: 'creator', amount: 300 }]);
  });

  it('ignores the percentage entirely once a side has collapsed', () => {
    // 90% of 300 is 270; a collapsed split must not send 270 and drop 30.
    expect(splitTipTotal(300, 90, CURATOR_ONLY)).toEqual([{ kind: 'curator', amount: 300 }]);
    expect(splitTipTotal(300, 10, CREATOR_ONLY)).toEqual([{ kind: 'creator', amount: 300 }]);
  });

  it('emits NOTHING when both sides are the viewer, and says so', () => {
    expect(splitTipTotal(300, 50, NEITHER)).toEqual([]);
    expect(validateTipSplit('300', 100000, 50, NEITHER)).toBe('There is no one to tip here.');
  });
});

describe('allowance + balance gates', () => {
  it('refuses a total over the remaining daily allowance', () => {
    expect(validateTipSplit('600', 100000, 50, BOTH, 500)).toBe("Only 500 Buzz left in today's tip allowance.");
  });

  it('allows a total exactly equal to the remaining allowance', () => {
    expect(validateTipSplit('500', 100000, 50, BOTH, 500)).toBeNull();
  });

  it('🔴 an UNKNOWN allowance does not pre-block — the default is the full daily cap', () => {
    // App passes `undefined` when the server read has not resolved or failed.
    // Pre-blocking there would make a network hiccup look like "you are out of Buzz".
    expect(validateTipSplit('4000', 100000, 50, BOTH, undefined)).toBeNull();
  });

  it('refuses a total over the viewer balance', () => {
    expect(validateTipSplit('400', 300, 50, BOTH)).toBe("That's more than your 300 Buzz balance.");
  });

  it('allows a total exactly equal to the balance', () => {
    expect(validateTipSplit('300', 300, 50, BOTH)).toBeNull();
  });

  it('skips the balance gate when the balance is unknown', () => {
    expect(validateTipSplit('400', null, 50, BOTH)).toBeNull();
  });

  it('rejects blanks and non-integers', () => {
    expect(validateTipSplit('', 5000, 50, BOTH)).toBe('Enter an amount.');
    expect(validateTipSplit('1.5', 5000, 50, BOTH)).toBe('Amount must be a whole number.');
    expect(validateTipSplit('0', 5000, 50, BOTH)).toBe('Minimum tip is 1 Buzz.');
    expect(validateTipSplit('-5', 5000, 50, BOTH)).toBe('Minimum tip is 1 Buzz.');
  });
});

describe('newIdempotencyKey', () => {
  it('mints a distinct non-empty key per call', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// T5 — the destination the viewer chose must be the destination the money goes to
// ---------------------------------------------------------------------------

describe('recipientChoice agrees with splitTipTotal at every percentage', () => {
  /**
   * 🔴 THE WHOLE 0..100 RANGE, NOT THE THREE LABELLED POINTS. The chip row sets
   * 100 / 50 / 0, so a test that only checks those three passes with either
   * boundary shifted by one — and a shifted boundary is exactly the defect worth
   * catching: the control would read "Split" while `splitTipTotal` sent one leg,
   * or read "Creator" while it sent two. Sweeping the range makes the label and
   * the transfer one claim rather than two that happen to agree at three points.
   */
  it('a choice of `split` means TWO legs, and `creator`/`curator` mean ONE', () => {
    for (let pct = 0; pct <= 100; pct += 1) {
      const legs = splitTipTotal(100, pct, BOTH);
      const choice = recipientChoice(pct);
      if (choice === 'split') {
        expect(legs, `pct=${pct}`).toHaveLength(2);
      } else {
        expect(legs, `pct=${pct}`).toHaveLength(1);
        expect(legs[0].kind, `pct=${pct}`).toBe(choice);
        // The single leg carries the WHOLE total — never a share of it.
        expect(legs[0].amount, `pct=${pct}`).toBe(100);
      }
    }
  });

  it('every named destination maps to a percentage that produces it', () => {
    // A round-trip rather than three hardcoded numbers: if someone set
    // `RECIPIENT_PERCENT.split` to 100 the chips would silently collapse to two
    // destinations, and only this pairing notices.
    const seen = new Set<TipRecipientChoice>();
    for (const [choice, pct] of Object.entries(RECIPIENT_PERCENT) as Array<[TipRecipientChoice, number]>) {
      expect(recipientChoice(pct), `${choice} -> ${pct}`).toBe(choice);
      seen.add(choice);
    }
    // 🔴 The set is CLOSED and has THREE members. Criterion 2 is "all three
    // targets", so a fourth (or a lost third) is a change to the promise.
    expect([...seen].sort()).toEqual(['creator', 'curator', 'split']);
  });

  it('a collapsed side ignores the percentage entirely', () => {
    // When one recipient is the viewer there is only one destination, whatever
    // the stored percentage says — the chip row is not even rendered there.
    for (const pct of [0, 1, 50, 99, 100]) {
      expect(splitTipTotal(100, pct, CREATOR_ONLY)).toEqual([{ kind: 'creator', amount: 100 }]);
      expect(splitTipTotal(100, pct, CURATOR_ONLY)).toEqual([{ kind: 'curator', amount: 100 }]);
    }
  });
});
