import { describe, expect, it } from 'vitest';

import { advanceOffset, clampDt, shouldAutoScroll, wrap } from './scroll-engine.js';

describe('wrap', () => {
  it('normalizes into [0, size)', () => {
    expect(wrap(0, 100)).toBe(0);
    expect(wrap(50, 100)).toBe(50);
    expect(wrap(100, 100)).toBe(0);
    expect(wrap(150, 100)).toBe(50);
    expect(wrap(250, 100)).toBe(50);
  });
  it('handles negative offsets (reverse motion)', () => {
    expect(wrap(-10, 100)).toBe(90);
    expect(wrap(-150, 100)).toBe(50);
  });
  it('returns 0 for a non-positive size or non-finite value', () => {
    expect(wrap(50, 0)).toBe(0);
    expect(wrap(50, -1)).toBe(0);
    expect(wrap(Number.NaN, 100)).toBe(0);
  });
});

describe('advanceOffset', () => {
  it('advances by speed*dt', () => {
    // 40 px/s for 0.5s = +20px
    expect(advanceOffset(0, 0.5, 40, 1000)).toBe(20);
    expect(advanceOffset(20, 0.25, 40, 1000)).toBe(30);
  });
  it('🔴 wraps seamlessly past the end of one content copy (no jump)', () => {
    // one copy is 100px; at 990 + (40*0.5=20) = 1010 → wraps to 10, not 1010.
    expect(advanceOffset(90, 0.5, 40, 100)).toBe(10);
    // exactly at the boundary lands on 0
    expect(advanceOffset(80, 0.5, 40, 100)).toBe(0);
  });
  it('returns 0 when nothing has been measured (contentSize <= 0)', () => {
    expect(advanceOffset(50, 0.5, 40, 0)).toBe(0);
  });
  it('treats a non-finite dt/speed as a no-op (keeps a wrapped current offset)', () => {
    expect(advanceOffset(30, Number.NaN, 40, 100)).toBe(30);
    expect(advanceOffset(130, 0.5, Number.POSITIVE_INFINITY, 100)).toBe(30);
  });
  it('accumulates deterministically over many frames back to a wrapped value', () => {
    let off = 0;
    for (let i = 0; i < 10; i += 1) off = advanceOffset(off, 0.1, 100, 250); // +10px each
    expect(off).toBe(100); // 10 frames * 10px = 100, within [0,250)
  });
});

describe('shouldAutoScroll', () => {
  it('runs when motion is allowed and not paused', () => {
    expect(shouldAutoScroll(false, false)).toBe(true);
  });
  it('🔴 is HARD-disabled by prefers-reduced-motion regardless of pause', () => {
    expect(shouldAutoScroll(true, false)).toBe(false);
    expect(shouldAutoScroll(true, true)).toBe(false);
  });
  it('is disabled while the user has paused', () => {
    expect(shouldAutoScroll(false, true)).toBe(false);
  });
});

describe('clampDt', () => {
  it('clamps a huge resumed-tab dt to the frame budget', () => {
    expect(clampDt(5)).toBe(0.1);
    expect(clampDt(0.016)).toBeCloseTo(0.016);
  });
  it('floors negatives / non-finite to 0', () => {
    expect(clampDt(-1)).toBe(0);
    expect(clampDt(Number.NaN)).toBe(0);
  });
});
