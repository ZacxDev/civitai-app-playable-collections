import { describe, expect, it } from 'vitest';

import { buildShareUrl, decodeDeepLink, encodeDeepLink, type DeepLinkState } from './deep-link.js';

describe('encodeDeepLink', () => {
  it('omits the default mode and a zero index', () => {
    expect(encodeDeepLink({ collectionId: 101, mode: 'classic', index: 0 })).toBe('c=101');
  });
  it('includes a non-default mode and a non-zero index', () => {
    expect(encodeDeepLink({ collectionId: 101, mode: 'continuous-horizontal', index: 5 })).toBe(
      'c=101&mode=continuous-horizontal&i=5',
    );
  });
});

describe('decodeDeepLink', () => {
  it('parses a bare id (defaults mode + index)', () => {
    expect(decodeDeepLink('c=101')).toEqual({ collectionId: 101, mode: 'classic', index: 0 });
  });
  it('tolerates a leading # or ?', () => {
    expect(decodeDeepLink('#c=101&mode=continuous-vertical&i=3')).toEqual({
      collectionId: 101,
      mode: 'continuous-vertical',
      index: 3,
    });
    expect(decodeDeepLink('?c=7')).toEqual({ collectionId: 7, mode: 'classic', index: 0 });
  });
  it('returns null for missing / invalid ids and empty input', () => {
    expect(decodeDeepLink(null)).toBeNull();
    expect(decodeDeepLink('')).toBeNull();
    expect(decodeDeepLink('#')).toBeNull();
    expect(decodeDeepLink('foo=bar')).toBeNull();
    expect(decodeDeepLink('c=abc')).toBeNull();
    expect(decodeDeepLink('c=-4')).toBeNull();
  });
  it('degrades a bad mode to classic and a bad/negative index to 0', () => {
    expect(decodeDeepLink('c=1&mode=nope&i=-2')).toEqual({ collectionId: 1, mode: 'classic', index: 0 });
  });
});

describe('round-trip encode -> decode restores collection + mode + position', () => {
  const cases: DeepLinkState[] = [
    { collectionId: 101, mode: 'classic', index: 0 },
    { collectionId: 42, mode: 'classic', index: 7 },
    { collectionId: 9, mode: 'continuous-horizontal', index: 0 },
    { collectionId: 999, mode: 'continuous-vertical', index: 12 },
  ];
  it.each(cases)('%o survives the round-trip', (state) => {
    expect(decodeDeepLink(encodeDeepLink(state))).toEqual(state);
  });
});

describe('buildShareUrl', () => {
  it('appends the encoded hash to a base URL', () => {
    expect(buildShareUrl('https://x.civit.ai/app', { collectionId: 101, mode: 'classic', index: 0 })).toBe(
      'https://x.civit.ai/app#c=101',
    );
  });
  it('replaces any existing hash on the base', () => {
    expect(buildShareUrl('https://x.civit.ai/app#c=1', { collectionId: 2, mode: 'continuous-vertical', index: 4 })).toBe(
      'https://x.civit.ai/app#c=2&mode=continuous-vertical&i=4',
    );
  });
});
