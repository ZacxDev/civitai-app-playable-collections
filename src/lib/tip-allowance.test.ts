import { describe, expect, it } from 'vitest';

import {
  TIP_DAILY_MAX,
  TIP_MAX_PER_TIP,
  effectiveTipCap,
  readDailySpent,
  recordTipSpend,
  remainingDaily,
} from './tip-allowance.js';

/** A tiny in-memory Storage for deterministic day-keyed persistence tests. */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

const DAY1 = Date.parse('2026-07-28T10:00:00Z');
const DAY1_LATER = Date.parse('2026-07-28T23:00:00Z');
const DAY2 = Date.parse('2026-07-29T01:00:00Z');

describe('tip caps mirror the server limits', () => {
  it('per-tip cap is 5000 and daily cap is 25000', () => {
    expect(TIP_MAX_PER_TIP).toBe(5000);
    expect(TIP_DAILY_MAX).toBe(25000);
  });
});

describe('daily-spend tracking (app-local)', () => {
  it('starts at 0 spent / full remaining', () => {
    const s = memStorage();
    expect(readDailySpent(s, DAY1)).toBe(0);
    expect(remainingDaily(s, DAY1)).toBe(25000);
  });

  it('accumulates within a day and decrements the remaining', () => {
    const s = memStorage();
    recordTipSpend(500, s, DAY1);
    recordTipSpend(1500, s, DAY1_LATER);
    expect(readDailySpent(s, DAY1)).toBe(2000);
    expect(remainingDaily(s, DAY1)).toBe(23000);
  });

  it('resets on a new UTC day', () => {
    const s = memStorage();
    recordTipSpend(9000, s, DAY1);
    expect(remainingDaily(s, DAY1)).toBe(16000);
    // Different calendar day → its own running total.
    expect(readDailySpent(s, DAY2)).toBe(0);
    expect(remainingDaily(s, DAY2)).toBe(25000);
  });

  it('never reports a negative remaining even past the cap', () => {
    const s = memStorage();
    recordTipSpend(30000, s, DAY1);
    expect(remainingDaily(s, DAY1)).toBe(0);
  });

  it('tolerates a null storage (privacy mode)', () => {
    expect(readDailySpent(null, DAY1)).toBe(0);
    expect(remainingDaily(null, DAY1)).toBe(25000);
    expect(recordTipSpend(100, null, DAY1)).toBe(100);
  });
});

describe('effectiveTipCap', () => {
  it('is the per-tip cap when the daily allowance is ample', () => {
    expect(effectiveTipCap(25000)).toBe(5000);
  });
  it('drops to the remaining daily allowance when it is below the per-tip cap', () => {
    expect(effectiveTipCap(300)).toBe(300);
  });
  it('is never negative', () => {
    expect(effectiveTipCap(-10)).toBe(0);
  });
});
