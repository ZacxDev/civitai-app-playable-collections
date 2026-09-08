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

  it('FAILS CLOSED on an unknown CEILING (pre-BLOCK_INIT / a host that omits it) — SFW only', () => {
    for (const ceiling of [undefined, Number.NaN, Infinity]) {
      expect(withinCeiling(PG, ceiling)).toBe(true);
      expect(withinCeiling(PG13, ceiling)).toBe(true);
      expect(withinCeiling(R, ceiling)).toBe(false);
      expect(withinCeiling(X, ceiling)).toBe(false);
      expect(withinCeiling(XXX, ceiling)).toBe(false);
    }
  });

  // ---- an EXPLICIT UNRATED 0 is PERMITTED; UNKNOWABLE input is REFUSED -------
  // 🔴 THESE TWO ARE THE SAME LINE OF CODE'S TWO HALVES, AND THEY MUST BE
  // SEPARATELY WITNESSED. An earlier revision refused BOTH — stricter than the
  // server, which is not "safe", it is the app overriding a platform decision, and
  // it is worse than the blur it replaced (a blurred item was still reachable; a
  // hidden one is gone). The server permits unrated at every ceiling:
  //
  //   <civitai>@origin/release block-collections.service.ts:193
  //     AND ((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)
  //   ...and its own predicate, :359  `if (!nsfwLevel) return true;`
  //
  // Written the server's truthy way (`!nsfwLevel`) `undefined` and `NaN` would be
  // permitted too. Any test that only checked ONE of these halves would pass with
  // the two re-merged in either direction, which is precisely how this shipped.

  it('🔴 an EXPLICIT UNRATED (0) item is PERMITTED, at EVERY ceiling incl. SFW (mirrors the server)', () => {
    for (const ceiling of [undefined, SFW_LEVELS, UP_TO_R, ALL, Number.NaN]) {
      expect(withinCeiling(0, ceiling)).toBe(true);
    }
  });

  it('🔴 UNKNOWABLE input is REFUSED — absent/null/NaN/Infinity/negative are NOT the same as 0', () => {
    for (const ceiling of [undefined, SFW_LEVELS, UP_TO_R, ALL]) {
      expect(withinCeiling(undefined, ceiling)).toBe(false);
      expect(withinCeiling(null, ceiling)).toBe(false);
      expect(withinCeiling(Number.NaN, ceiling)).toBe(false);
      expect(withinCeiling(Infinity, ceiling)).toBe(false);
      // 🔴 -5 & 3 === 3 in two's complement, so without an explicit sign guard a
      // negative level would sail through the bitwise test as PERMITTED.
      expect(withinCeiling(-5, ceiling)).toBe(false);
      expect(withinCeiling(-1, ceiling)).toBe(false);
    }
  });

  it('🔴 THE PAIR, IN ONE ASSERTION: 0 and undefined must DISAGREE on every ceiling', () => {
    // The anti-merge witness. Either collapse — refusing 0, or permitting absent —
    // makes these two equal and fails here, whichever direction someone merges in.
    for (const ceiling of [undefined, SFW_LEVELS, ALL]) {
      expect(withinCeiling(0, ceiling)).toBe(true);
      expect(withinCeiling(undefined, ceiling)).toBe(false);
      expect(withinCeiling(0, ceiling)).not.toBe(withinCeiling(undefined, ceiling));
    }
  });

  it('🔴 INTERSECTION, not containment: a MIXED level sharing ONE permitted bit is permitted', () => {
    // The server's test is bitwise `& != 0` and its own comment says why a `<=`
    // (or a containment) test would be wrong: "29 is a mixed bucket that
    // intersects a SFW ceiling". The SDK's `isLevelAllowed` is containment BY
    // DESIGN — it answers "may I offer an R affordance?" for a single bit — so it
    // is deliberately NOT used here. The two agree on every single-bit level and
    // diverge only on OR-ed values, which is exactly what this pins.
    expect(withinCeiling(PG | PG13, SFW_LEVELS)).toBe(true);
    expect(withinCeiling(PG | R, SFW_LEVELS)).toBe(true); // shares the PG bit
    expect(withinCeiling(29, SFW_LEVELS)).toBe(true); // the server's own example
    // …and a level sharing NO bit with the ceiling is still refused.
    expect(withinCeiling(R | X, SFW_LEVELS)).toBe(false);
    expect(withinCeiling(XXX, UP_TO_R)).toBe(false);
  });
});

describe('filterToCeiling', () => {
  const item = (id: number, nsfwLevel: number) => ({ id, nsfwLevel });

  it('keeps only the permitted items, preserving order — and item 5 is UNRATED, so it stays', () => {
    const items = [item(1, PG), item(2, X), item(3, PG13), item(4, R), item(5, 0)];
    // 🔴 Item 5 (`nsfwLevel: 0`) survives EVERY ceiling. It used to be dropped
    // from all three of these lists; that was the app overriding the server.
    expect(filterToCeiling(items, SFW_LEVELS).map((i) => i.id)).toEqual([1, 3, 5]);
    expect(filterToCeiling(items, UP_TO_R).map((i) => i.id)).toEqual([1, 3, 4, 5]);
    expect(filterToCeiling(items, ALL).map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('is IDEMPOTENT — the surfaces re-apply it over an already-filtered list', () => {
    const items = [item(1, PG), item(2, X), item(3, R)];
    const once = filterToCeiling(items, UP_TO_R);
    expect(filterToCeiling(once, UP_TO_R)).toEqual(once);
  });

  it('drops everything above SFW when the ceiling is unknown — but keeps the unrated one', () => {
    const items = [item(1, PG13), item(2, R), item(3, 0)];
    expect(filterToCeiling(items, undefined).map((i) => i.id)).toEqual([1, 3]);
  });
});
