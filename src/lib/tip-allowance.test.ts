import { describe, expect, it } from 'vitest';

import { TIP_DAILY_MAX, TIP_MAX_PER_TIP, TIP_MIN, effectiveTipCap } from './tip-allowance.js';

// 🔴 THE localStorage SUITES THAT LIVED HERE ARE DELETED, NOT SKIPPED (0.2.10).
// They covered `readDailySpent` / `recordTipSpend` / `remainingDaily` /
// `useDailyTipAllowance`, which derived the remaining daily allowance from a
// per-device running total. That mechanism is gone: localStorage throws in the
// opaque-origin sandbox, so the estimate was always the full cap and tracked
// nothing, and even where it persisted it counted only tips made through THIS
// app on THIS device. The allowance now comes from the server — see
// `useServerTipAllowance` and its tests in ./tip-allowance.test.tsx (a .tsx,
// because vite.config.ts routes .test.ts to the DOM-less `node` project and a
// hook test needs jsdom).

describe('tip caps mirror the server limits', () => {
  it('per-tip cap is 5000, daily cap is 25000, per-transfer minimum is 1', () => {
    expect(TIP_MAX_PER_TIP).toBe(5000);
    expect(TIP_DAILY_MAX).toBe(25000);
    expect(TIP_MIN).toBe(1);
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
