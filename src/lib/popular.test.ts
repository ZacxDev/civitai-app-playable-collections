import { describe, expect, it } from 'vitest';

import type { SharedAppendValue, SharedListItem } from '@civitai/blocks-react';

import { entryCollectionId, readPopular, recordPlay, totalBuzz, type SharedStore } from './popular.js';

/**
 * A minimal in-memory fake of the SHARED store's `list`/`append`/`vote` surface,
 * with the host's one-idempotent-vote-per-viewer invariant, so the popularity
 * helpers can be exercised without a real host bridge.
 */
function makeFakeShared(viewer = 99) {
  let seq = 0;
  const entries: SharedListItem[] = [];
  const voters = new Map<string, Set<number>>();

  const store: SharedStore & { entries: SharedListItem[]; seed(value: SharedAppendValue, votes: number[]): string } = {
    entries,
    seed(value, votes) {
      const key = `k${++seq}`;
      entries.push({ key, authorUserId: viewer, value, count: votes.length, createdAt: new Date(), updatedAt: new Date() });
      voters.set(key, new Set(votes));
      return key;
    },
    async list(opts) {
      // Host lists newest-first.
      const items = [...entries].reverse();
      return { items: opts?.limit != null ? items.slice(0, opts.limit) : items };
    },
    async append(value) {
      const key = `k${++seq}`;
      entries.push({ key, authorUserId: viewer, value, count: 0, createdAt: new Date(), updatedAt: new Date() });
      voters.set(key, new Set());
      return { key };
    },
    async vote(key) {
      const set = voters.get(key) ?? new Set<number>();
      set.add(viewer);
      voters.set(key, set);
      const entry = entries.find((e) => e.key === key);
      if (entry) entry.count = set.size;
      return entry?.count ?? 0;
    },
  };
  return store;
}

describe('entryCollectionId', () => {
  it('extracts a finite numeric collectionId from the opaque data blob', () => {
    expect(entryCollectionId({ title: 't', data: { collectionId: 42 } })).toBe(42);
  });
  it('returns null for missing / malformed data', () => {
    expect(entryCollectionId({ title: 't' })).toBeNull();
    expect(entryCollectionId({ title: 't', data: {} })).toBeNull();
    expect(entryCollectionId({ title: 't', data: { collectionId: 'nope' } })).toBeNull();
    expect(entryCollectionId({ title: 't', data: { collectionId: Number.NaN } })).toBeNull();
    expect(entryCollectionId({ title: 't', data: 'scalar' })).toBeNull();
  });
});

describe('recordPlay', () => {
  it('creates one entry tagged with the collectionId and self-votes it to count 1', async () => {
    const shared = makeFakeShared(99);
    await recordPlay(shared, { id: 101, name: 'Neon Cities' });
    expect(shared.entries).toHaveLength(1);
    expect(shared.entries[0].value.title).toBe('Neon Cities');
    expect(entryCollectionId(shared.entries[0].value)).toBe(101);
    expect(shared.entries[0].count).toBe(1);
  });

  it('is idempotent per viewer: replaying the same collection does not add an entry or inflate the count', async () => {
    const shared = makeFakeShared(99);
    await recordPlay(shared, { id: 101, name: 'Neon Cities' });
    await recordPlay(shared, { id: 101, name: 'Neon Cities' });
    expect(shared.entries).toHaveLength(1);
    expect(shared.entries[0].count).toBe(1);
  });

  it('votes on the existing entry rather than creating a duplicate', async () => {
    const shared = makeFakeShared(99);
    // Seed an entry authored by someone else with 0 votes.
    shared.seed({ title: 'Neon Cities', data: { collectionId: 101 } }, []);
    await recordPlay(shared, { id: 101, name: 'Neon Cities' });
    expect(shared.entries).toHaveLength(1);
    expect(shared.entries[0].count).toBe(1);
  });

  it('falls back to a synthesized title when the name is blank', async () => {
    const shared = makeFakeShared(99);
    await recordPlay(shared, { id: 7, name: '   ' });
    expect(shared.entries[0].value.title).toBe('Collection 7');
  });
});

describe('readPopular', () => {
  it('ranks by vote count desc, drops untagged / zero-count entries, and applies the limit', async () => {
    const shared = makeFakeShared(99);
    shared.seed({ title: 'A', data: { collectionId: 1 } }, [1, 2, 3]); // count 3
    shared.seed({ title: 'B', data: { collectionId: 2 } }, [1]); // count 1
    shared.seed({ title: 'C', data: { collectionId: 3 } }, [1, 2]); // count 2
    shared.seed({ title: 'Zero', data: { collectionId: 4 } }, []); // count 0 -> dropped
    shared.seed({ title: 'Untagged' }, [1, 2, 3, 4]); // no collectionId -> dropped

    expect(await readPopular(shared, 10)).toEqual([
      { collectionId: 1, count: 3 },
      { collectionId: 3, count: 2 },
      { collectionId: 2, count: 1 },
    ]);
    expect(await readPopular(shared, 1)).toEqual([{ collectionId: 1, count: 3 }]);
  });

  it('returns an empty list when nothing has been played', async () => {
    const shared = makeFakeShared(99);
    expect(await readPopular(shared, 10)).toEqual([]);
  });
});

describe('totalBuzz', () => {
  it('sums the per-pool balances', () => {
    expect(totalBuzz({ blue: 1000, green: 34, yellow: 200 })).toBe(1234);
    expect(totalBuzz({ blue: 0, green: 0, yellow: 0 })).toBe(0);
  });
  it('passes null through (balance not yet loaded)', () => {
    expect(totalBuzz(null)).toBeNull();
  });
});
