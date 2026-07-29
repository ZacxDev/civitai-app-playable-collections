import { describe, expect, it } from 'vitest';

import { hasMaturityBadge, maturityBucket, maturityLabel, shouldBlur } from './maturity.js';

describe('maturityBucket', () => {
  it('buckets each nsfwLevel tier by its highest set bit', () => {
    expect(maturityBucket(1)).toBe('pg');
    expect(maturityBucket(2)).toBe('pg13');
    expect(maturityBucket(4)).toBe('r');
    expect(maturityBucket(8)).toBe('x');
    expect(maturityBucket(16)).toBe('xxx');
    expect(maturityBucket(28)).toBe('xxx'); // OR'd bits → highest tier
  });
  it('FAILS CLOSED: unknown / 0 / non-finite → unknown (mature), never PG', () => {
    expect(maturityBucket(Number.NaN)).toBe('unknown');
    expect(maturityBucket(0)).toBe('unknown');
    expect(maturityBucket(-5)).toBe('unknown');
    expect(maturityBucket(Infinity)).toBe('unknown');
  });
});

describe('maturityLabel', () => {
  it('maps a level to a human rating label', () => {
    expect(maturityLabel(1)).toBe('PG');
    expect(maturityLabel(2)).toBe('PG-13');
    expect(maturityLabel(4)).toBe('R');
    expect(maturityLabel(8)).toBe('X');
    expect(maturityLabel(16)).toBe('XXX');
  });
});

describe('shouldBlur / hasMaturityBadge', () => {
  it('blurs anything above PG-13 (R and up) AND unknown/0 (fail closed), never PG/PG-13', () => {
    expect(shouldBlur(1)).toBe(false);
    expect(shouldBlur(2)).toBe(false);
    expect(shouldBlur(4)).toBe(true);
    expect(shouldBlur(8)).toBe(true);
    expect(shouldBlur(16)).toBe(true);
    // Fail closed:
    expect(shouldBlur(0)).toBe(true);
    expect(shouldBlur(Number.NaN)).toBe(true);
  });
  it('shows a badge for anything above PG (incl. unknown → neutral "Unrated")', () => {
    expect(hasMaturityBadge(1)).toBe(false);
    expect(hasMaturityBadge(2)).toBe(true);
    expect(hasMaturityBadge(4)).toBe(true);
    expect(hasMaturityBadge(0)).toBe(true);
    // An unknown/unrated level is still gated, but labelled neutrally — NOT the
    // alarming "NSFW", which over-states what we actually know about the item.
    expect(maturityLabel(0)).toBe('Unrated');
  });
});
