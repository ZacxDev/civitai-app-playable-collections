import { describe, expect, it } from 'vitest';

import { BrowsingLevel, SFW_LEVELS } from '@civitai/app-sdk/blocks';

import { filterToCeiling, hasMaturityBadge, maturityBucket, maturityLabel, withinCeiling } from './maturity.js';

/** Every level bit, so a fixture never has to spell a magic number. */
const { PG, PG13, R, X, XXX } = BrowsingLevel;
/** A ceiling that permits PG + PG-13 + R but NOT X/XXX — the middle point. */
const UP_TO_R = SFW_LEVELS | R;
/** A red-capable host: every level permitted. */
const ALL = SFW_LEVELS | R | X | XXX;

describe('maturityBucket', () => {
  it('buckets each nsfwLevel tier by its highest set bit', () => {
    expect(maturityBucket(PG)).toBe('pg');
    expect(maturityBucket(PG13)).toBe('pg13');
    expect(maturityBucket(R)).toBe('r');
    expect(maturityBucket(X)).toBe('x');
    expect(maturityBucket(XXX)).toBe('xxx');
    expect(maturityBucket(28)).toBe('xxx'); // OR'd bits → highest tier
  });
  it('is TOTAL: 0 / non-finite / negative map to "unknown", never to PG', () => {
    // Such an item is never rendered (`withinCeiling` refuses it below); this
    // pins that the bucket does not silently call an unrated item safe.
    expect(maturityBucket(Number.NaN)).toBe('unknown');
    expect(maturityBucket(0)).toBe('unknown');
    expect(maturityBucket(-5)).toBe('unknown');
    expect(maturityBucket(Infinity)).toBe('unknown');
  });
});

describe('maturityLabel', () => {
  it('maps a level to a human rating label', () => {
    expect(maturityLabel(PG)).toBe('PG');
    expect(maturityLabel(PG13)).toBe('PG-13');
    expect(maturityLabel(R)).toBe('R');
    expect(maturityLabel(X)).toBe('X');
    expect(maturityLabel(XXX)).toBe('XXX');
    expect(maturityLabel(0)).toBe('Unrated');
  });
});

describe('hasMaturityBadge', () => {
  it('badges anything above PG — the badge LABELS permitted content, it gates nothing', () => {
    expect(hasMaturityBadge(PG)).toBe(false);
    expect(hasMaturityBadge(PG13)).toBe(true);
    expect(hasMaturityBadge(R)).toBe(true);
    expect(hasMaturityBadge(X)).toBe(true);
  });
});

describe('withinCeiling — the one predicate the whole app renders from', () => {
  it('permits a level the ceiling contains, on a SFW ceiling', () => {
    expect(withinCeiling(PG, SFW_LEVELS)).toBe(true);
    expect(withinCeiling(PG13, SFW_LEVELS)).toBe(true);
  });

  it('refuses a level the ceiling excludes, on a SFW ceiling', () => {
    expect(withinCeiling(R, SFW_LEVELS)).toBe(false);
    expect(withinCeiling(X, SFW_LEVELS)).toBe(false);
    expect(withinCeiling(XXX, SFW_LEVELS)).toBe(false);
  });

  // 🔴 THE TWO DIRECTIONS OF DISAGREEMENT. A suite whose ceiling and item always
  // agree cannot tell "gated on the ceiling" from "gated on the item level" —
  // both fixtures below hold the ITEM constant and move only the CEILING, and the
  // pair below them holds the CEILING constant and moves only the ITEM.
  it('the SAME R item flips with the ceiling: refused under SFW, permitted under a wider one', () => {
    expect(withinCeiling(R, SFW_LEVELS)).toBe(false);
    expect(withinCeiling(R, UP_TO_R)).toBe(true);
    expect(withinCeiling(R, ALL)).toBe(true);
  });

  it('the SAME up-to-R ceiling flips with the item: PG-13 and R in, X and XXX out', () => {
    expect(withinCeiling(PG13, UP_TO_R)).toBe(true);
    expect(withinCeiling(R, UP_TO_R)).toBe(true);
    expect(withinCeiling(X, UP_TO_R)).toBe(false);
    expect(withinCeiling(XXX, UP_TO_R)).toBe(false);
  });

  it('a PERMISSIVE ceiling is not a licence: it still refuses an unrated (0) item', () => {
    expect(withinCeiling(0, ALL)).toBe(false);
  });

  it('FAILS CLOSED on an unknown CEILING (pre-BLOCK_INIT / a host that omits it) — SFW only', () => {
    for (const ceiling of [undefined, Number.NaN, Infinity]) {
      expect(withinCeiling(PG, ceiling)).toBe(true);
      expect(withinCeiling(PG13, ceiling)).toBe(true);
      expect(withinCeiling(R, ceiling)).toBe(false);
      expect(withinCeiling(X, ceiling)).toBe(false);
      expect(withinCeiling(XXX, ceiling)).toBe(false);
    }
  });

  it('FAILS CLOSED on an unrated / malformed ITEM level, under EVERY ceiling', () => {
    for (const ceiling of [undefined, SFW_LEVELS, UP_TO_R, ALL]) {
      expect(withinCeiling(0, ceiling)).toBe(false);
      expect(withinCeiling(Number.NaN, ceiling)).toBe(false);
      expect(withinCeiling(-1, ceiling)).toBe(false);
    }
  });

  it('FAILS CLOSED on an ABSENT level — no claim is not a permission', () => {
    // The only field that can be absent is `CollectionSummary.coverNsfwLevel`.
    for (const ceiling of [undefined, SFW_LEVELS, ALL]) {
      expect(withinCeiling(undefined, ceiling)).toBe(false);
    }
  });

  it('CONTAINMENT, not intersection: an OR-ed level needs EVERY bit permitted', () => {
    // 3 = PG|PG13 fits a SFW ceiling; 5 = PG|R does not, even though it shares
    // the PG bit. An `&` "intersects" test would wrongly permit the second.
    expect(withinCeiling(PG | PG13, SFW_LEVELS)).toBe(true);
    expect(withinCeiling(PG | R, SFW_LEVELS)).toBe(false);
    expect(withinCeiling(PG | R, UP_TO_R)).toBe(true);
  });
});

describe('filterToCeiling', () => {
  const item = (id: number, nsfwLevel: number) => ({ id, nsfwLevel });

  it('keeps only the permitted items, preserving order', () => {
    const items = [item(1, PG), item(2, X), item(3, PG13), item(4, R), item(5, 0)];
    expect(filterToCeiling(items, SFW_LEVELS).map((i) => i.id)).toEqual([1, 3]);
    expect(filterToCeiling(items, UP_TO_R).map((i) => i.id)).toEqual([1, 3, 4]);
    expect(filterToCeiling(items, ALL).map((i) => i.id)).toEqual([1, 2, 3, 4]);
  });

  it('is IDEMPOTENT — the surfaces re-apply it over an already-filtered list', () => {
    const items = [item(1, PG), item(2, X), item(3, R)];
    const once = filterToCeiling(items, UP_TO_R);
    expect(filterToCeiling(once, UP_TO_R)).toEqual(once);
  });

  it('drops EVERYTHING above SFW when the ceiling is unknown', () => {
    const items = [item(1, PG13), item(2, R), item(3, 0)];
    expect(filterToCeiling(items, undefined).map((i) => i.id)).toEqual([1]);
  });
});
