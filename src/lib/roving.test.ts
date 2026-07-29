import { describe, expect, it } from 'vitest';

import { nextIndex, rovingAction } from './roving.js';

describe('rovingAction', () => {
  it('maps horizontal arrow keys', () => {
    expect(rovingAction('ArrowRight')).toBe('next');
    expect(rovingAction('ArrowLeft')).toBe('prev');
    expect(rovingAction('ArrowDown', 'horizontal')).toBeNull();
  });
  it('maps vertical arrow keys', () => {
    expect(rovingAction('ArrowDown', 'vertical')).toBe('next');
    expect(rovingAction('ArrowUp', 'vertical')).toBe('prev');
    expect(rovingAction('ArrowRight', 'vertical')).toBeNull();
  });
  it('maps Home/End in both orientations', () => {
    expect(rovingAction('Home')).toBe('first');
    expect(rovingAction('End')).toBe('last');
    expect(rovingAction('Home', 'vertical')).toBe('first');
  });
  it('returns null for unrelated keys', () => {
    expect(rovingAction('a')).toBeNull();
    expect(rovingAction('Enter')).toBeNull();
  });
});

describe('nextIndex', () => {
  it('advances and wraps at the end', () => {
    expect(nextIndex('next', 0, 3)).toBe(1);
    expect(nextIndex('next', 2, 3)).toBe(0);
  });
  it('goes back and wraps at the start', () => {
    expect(nextIndex('prev', 1, 3)).toBe(0);
    expect(nextIndex('prev', 0, 3)).toBe(2);
  });
  it('jumps to first/last', () => {
    expect(nextIndex('first', 2, 3)).toBe(0);
    expect(nextIndex('last', 0, 3)).toBe(2);
  });
  it('is a no-op for null or empty groups', () => {
    expect(nextIndex(null, 1, 3)).toBe(1);
    expect(nextIndex('next', 0, 0)).toBe(0);
  });
});
