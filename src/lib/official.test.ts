import { describe, expect, it } from 'vitest';

import { isOfficialAccount, isOfficialCollection } from './official.js';
import type { CollectionSummary } from '../types.js';

const summary = (username: string | null): CollectionSummary => ({
  id: 1,
  name: 'Any',
  description: null,
  coverImageUrl: null,
  itemCount: 3,
  curator: { userId: 5, username },
  isPublic: true,
  followed: false,
});

describe('isOfficialAccount — the username rule the payload supports', () => {
  it('matches the official account exactly', () => {
    expect(isOfficialAccount({ userId: 1, username: 'Civitai' })).toBe(true);
  });

  it('is case-insensitive (usernames are case-insensitively unique)', () => {
    expect(isOfficialAccount({ userId: 1, username: 'civitai' })).toBe(true);
    expect(isOfficialAccount({ userId: 1, username: 'CIVITAI' })).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isOfficialAccount({ userId: 1, username: ' Civitai ' })).toBe(true);
  });

  it('does NOT match lookalike or fan accounts — exact match only', () => {
    expect(isOfficialAccount({ userId: 7, username: 'civitaiart' })).toBe(false);
    expect(isOfficialAccount({ userId: 7, username: 'CivitaiFan' })).toBe(false);
    expect(isOfficialAccount({ userId: 7, username: 'CivitaiTeam' })).toBe(false);
    expect(isOfficialAccount({ userId: 7, username: 'alice' })).toBe(false);
  });

  it('does not key on userId — the payload carries no official id to pin', () => {
    // Same numeric id, ordinary username: not official.
    expect(isOfficialAccount({ userId: 1, username: 'someone' })).toBe(false);
  });

  it('is false for missing identity (null user, null/empty username)', () => {
    expect(isOfficialAccount(null)).toBe(false);
    expect(isOfficialAccount(undefined)).toBe(false);
    expect(isOfficialAccount({ userId: 5, username: null })).toBe(false);
    expect(isOfficialAccount({ userId: 5, username: '' })).toBe(false);
  });
});

describe('isOfficialCollection', () => {
  it('reads the curator off the summary', () => {
    expect(isOfficialCollection(summary('Civitai'))).toBe(true);
    expect(isOfficialCollection(summary('alice'))).toBe(false);
    expect(isOfficialCollection(summary(null))).toBe(false);
  });
});
