import { describe, expect, it, vi } from 'vitest';

import type { SharedAppendValue, SharedListItem } from '@civitai/blocks-react';

import {
  POPULAR_MIN_ENTRIES,
  POPULAR_MIN_PLAYS,
  entryCollectionId,
  popularRailEntries,
  readPopular,
  recordPlay,
  resolvePopularEntries,
  summaryFromPage,
  totalBuzz,
  type SharedStore,
} from './popular.js';
import type { CollectionPage, CollectionSummary, PopularEntry } from '../types.js';

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
      entries.push({
        key, authorUserId: viewer, value, count: votes.length,
        createdAt: new Date(), updatedAt: new Date(),
        // 🔴 DERIVED from the same `votes` this seed was handed, never hardcoded.
        // `viewerVoted` arrived as a REQUIRED field in @civitai/blocks-react
        // 0.47.0; a fake that pinned it to a constant would encode a shape the
        // real host never produces, and every test reading it would agree with
        // the fake instead of with the contract.
        viewerVoted: votes.includes(viewer),
      });
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
      entries.push({
        key, authorUserId: viewer, value, count: 0,
        createdAt: new Date(), updatedAt: new Date(),
        // A freshly appended entry carries no vote from its own author.
        viewerVoted: false,
      });
      voters.set(key, new Set());
      return { key };
    },
    async vote(key) {
      const set = voters.get(key) ?? new Set<number>();
      set.add(viewer);
      voters.set(key, set);
      const entry = entries.find((e) => e.key === key);
      // 🔴 BOTH fields move together. Updating `count` alone would let `list`
      // report viewerVoted:false for an entry this viewer just voted on — the
      // fake would then be the only place that behaviour exists.
      if (entry) { entry.count = set.size; entry.viewerVoted = true; }
      return entry?.count ?? 0;
    },
  };
  return store;
}

/**
 * 🔴 A TEST OF THE FAKE, ON PURPOSE — and the only kind of test that can catch
 * this class. `viewerVoted` arrived as a REQUIRED field on `SharedListItem` in
 * @civitai/blocks-react 0.47.0, and no production code here reads it yet. So a
 * fake that reported a constant would be green forever, and the first consumer
 * would be written against the fake's shape rather than the host's — the
 * "both-wrong-blind" failure, where the fixture encodes the same wrong shape as
 * the code that reads it.
 *
 * MEASURED: with these two cases absent, reverting the fake's vote path to
 * update `count` alone left the whole file green (18/18). They are what makes
 * that line load-bearing.
 */
describe('the fake shared store matches the host contract for viewerVoted', () => {
  it('reports false for an entry this viewer has not voted on', async () => {
    const shared = makeFakeShared(99);
    shared.seed({ title: 'a', data: { collectionId: 1 } }, [7, 8]); // other voters only
    const { items } = await shared.list();
    expect(items[0].count).toBe(2);
    expect(items[0].viewerVoted).toBe(false);
  });

  it('reports true once this viewer votes, without a re-list from scratch', async () => {
    const shared = makeFakeShared(99);
    const key = shared.seed({ title: 'a', data: { collectionId: 1 } }, []);
    expect((await shared.list()).items[0].viewerVoted).toBe(false);
    await shared.vote(key);
    const { items } = await shared.list();
    // 🔴 BOTH, because updating count alone is the mutant that survived.
    expect(items[0].count).toBe(1);
    expect(items[0].viewerVoted).toBe(true);
  });

  it('reports false for an entry this viewer just appended — appending is not voting', async () => {
    // The third arm. Measured: without this, flipping append()'s `viewerVoted`
    // to true survived the whole file. `recordPlay` goes through append, so a
    // fake that auto-votes the author would silently inflate every first play.
    const shared = makeFakeShared(99);
    await shared.append({ title: 'fresh', data: { collectionId: 5 } });
    const { items } = await shared.list();
    expect(items[0].count).toBe(0);
    expect(items[0].viewerVoted).toBe(false);
  });

  it('reports true for a seeded entry whose votes already include this viewer', async () => {
    const shared = makeFakeShared(99);
    shared.seed({ title: 'a', data: { collectionId: 1 } }, [7, 99]);
    const { items } = await shared.list();
    expect(items[0].viewerVoted).toBe(true);
  });
});

describe('popularRailEntries — the rail must earn its heading', () => {
  const e = (count: number) => ({ count });

  it('hides everything when no entry clears the play floor', () => {
    // The measured live shape: 6, 1, 1, 1, 1. One entry clears the floor, which
    // is not a ranking, so the rail renders nothing.
    expect(popularRailEntries([e(6), e(1), e(1), e(1), e(1)])).toEqual([]);
  });

  it('does NOT let sub-floor entries pad the set up to the entry floor', () => {
    // 🔴 The ordering of the two checks is the whole point: six one-play entries
    // would satisfy POPULAR_MIN_ENTRIES if the count were taken before the
    // filter. Filtering first is what makes the play floor load-bearing.
    expect(popularRailEntries([e(1), e(1), e(1), e(1), e(1), e(1)])).toEqual([]);
  });

  it('shows the qualifying entries once BOTH floors are met', () => {
    const kept = popularRailEntries([e(9), e(4), e(2), e(1)]);
    // The sub-floor entry is dropped, the rest survive in order.
    expect(kept.map((x) => x.count)).toEqual([9, 4, 2]);
  });

  it('is exactly AT the boundary, not one either side of it', () => {
    // 🔴 Boundary pinned against the CONSTANTS, not against literals, so a
    // deliberate change to either floor moves this test with it — while an
    // accidental off-by-one still fails.
    const atFloor = Array.from({ length: POPULAR_MIN_ENTRIES }, () => e(POPULAR_MIN_PLAYS));
    expect(popularRailEntries(atFloor)).toHaveLength(POPULAR_MIN_ENTRIES);

    const oneShortOnCount = Array.from({ length: POPULAR_MIN_ENTRIES }, () => e(POPULAR_MIN_PLAYS - 1));
    expect(popularRailEntries(oneShortOnCount)).toEqual([]);

    const oneShortOnEntries = Array.from({ length: POPULAR_MIN_ENTRIES - 1 }, () => e(POPULAR_MIN_PLAYS));
    expect(popularRailEntries(oneShortOnEntries)).toEqual([]);
  });

  it('an empty input is empty out, without throwing', () => {
    expect(popularRailEntries([])).toEqual([]);
  });
});

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

/**
 * REGRESSION GUARD (the whole reason for v0.1.7): the OLD code posted a GUESSED
 * `{ key: "playcount:<id>" }` counter shape to a shared-storage/increment route.
 * The real SHARED store is a votable-entry model — `append({ value: { title,
 * data } })` then `vote(key)`. These tests PIN the exact method + payload so the
 * guessed-`{key}` shape can never silently come back.
 */
describe('recordPlay — pins the SHARED-store call shape (no more guessed {key})', () => {
  it('appends { title, data: { collectionId } } then votes the minted key — never a raw counter key', async () => {
    const append = vi.fn(async (_value: SharedAppendValue) => ({ key: 'entry-key-1' }));
    const vote = vi.fn(async () => 1);
    const list = vi.fn(async () => ({ items: [] as SharedListItem[] }));
    const shared: SharedStore = { append, vote, list };

    await recordPlay(shared, { id: 101, name: 'Neon Cities' });

    // The entry is the votable `{ title, body?, data }` record — the moderated
    // human title in `title`, the app's opaque collectionId in `data`.
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith({ title: 'Neon Cities', data: { collectionId: 101 } });
    // NOT the retired guessed counter shape.
    expect(append).not.toHaveBeenCalledWith(expect.objectContaining({ key: expect.anything() }));

    // Then an idempotent up-vote on the host-minted key (not a synthesized
    // "playcount:101" string).
    expect(vote).toHaveBeenCalledTimes(1);
    expect(vote).toHaveBeenCalledWith('entry-key-1');
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

const summary = (over: Partial<CollectionSummary> = {}): CollectionSummary => ({
  id: 1,
  name: 'C1',
  description: null,
  coverImageUrl: null,
  itemCount: 3,
  curator: { userId: 5, username: 'curator' },
  isPublic: true,
  followed: false,
  ...over,
});

describe('summaryFromPage', () => {
  it('builds a grid summary from a detail page, deriving the cover from the first item', () => {
    const page: CollectionPage = {
      collection: { id: 42, name: 'Deep Cut', description: 'd', curator: { userId: 7, username: 'z' }, isPublic: true, followed: true },
      items: [
        { mediaId: 1, type: 'image', url: 'https://x/1.jpg', width: 1, height: 1, creator: { userId: 7, username: 'z' }, nsfwLevel: 1 },
      ],
    };
    expect(summaryFromPage(page)).toEqual({
      id: 42,
      name: 'Deep Cut',
      description: 'd',
      coverImageUrl: 'https://x/1.jpg',
      itemCount: 1,
      curator: { userId: 7, username: 'z' },
      isPublic: true,
      followed: true,
      coverNsfwLevel: 1,
    });
  });

  it('gates the cover by the HIGHEST-rated loaded item (safety)', () => {
    const page: CollectionPage = {
      collection: { id: 1, name: 'Mixed', description: null, curator: { userId: 1, username: 'z' }, isPublic: true, followed: false },
      items: [
        { mediaId: 1, type: 'image', url: 'https://x/1.jpg', width: 1, height: 1, creator: { userId: 1, username: 'z' }, nsfwLevel: 1 },
        { mediaId: 2, type: 'image', url: 'https://x/2.jpg', width: 1, height: 1, creator: { userId: 1, username: 'z' }, nsfwLevel: 8 },
      ],
    };
    // Cover thumbnail must never be less-blurred than the media it represents.
    expect(summaryFromPage(page).coverNsfwLevel).toBe(8);
  });

  it('tolerates an empty item page (null cover, undefined level)', () => {
    const page: CollectionPage = {
      collection: { id: 9, name: 'Empty', description: null, curator: { userId: 1, username: null }, isPublic: false, followed: false },
      items: [],
    };
    expect(summaryFromPage(page).coverImageUrl).toBeNull();
    expect(summaryFromPage(page).itemCount).toBe(0);
    expect(summaryFromPage(page).coverNsfwLevel).toBeUndefined();
  });
});

describe('resolvePopularEntries', () => {
  const entries: PopularEntry[] = [
    { collectionId: 1, count: 9 },
    { collectionId: 2, count: 5 },
    { collectionId: 3, count: 2 },
  ];

  it('resolves ids from the known map without fetching', async () => {
    const known = new Map<number, CollectionSummary>([
      [1, summary({ id: 1, name: 'One' })],
      [2, summary({ id: 2, name: 'Two' })],
      [3, summary({ id: 3, name: 'Three' })],
    ]);
    const fetchSummary = vi.fn(async () => null as CollectionSummary | null);
    const resolved = await resolvePopularEntries(entries, known, fetchSummary);
    expect(resolved.map((r) => r.collection.name)).toEqual(['One', 'Two', 'Three']);
    expect(resolved.map((r) => r.count)).toEqual([9, 5, 2]);
    // Everything was known → no by-id fetch.
    expect(fetchSummary).not.toHaveBeenCalled();
  });

  it('fetches summaries for ids NOT on any loaded list, preserving rank order (the v0.1.9 fix)', async () => {
    // Only id 2 is loaded; 1 and 3 must be fetched by id and still rank correctly.
    const known = new Map<number, CollectionSummary>([[2, summary({ id: 2, name: 'Two (known)' })]]);
    const fetchSummary = vi.fn(async (id: number) => summary({ id, name: `Fetched ${id}` }));
    const resolved = await resolvePopularEntries(entries, known, fetchSummary);
    expect(resolved.map((r) => r.collection.name)).toEqual(['Fetched 1', 'Two (known)', 'Fetched 3']);
    expect(resolved.map((r) => r.collection.id)).toEqual([1, 2, 3]);
    expect(fetchSummary).toHaveBeenCalledWith(1);
    expect(fetchSummary).toHaveBeenCalledWith(3);
    expect(fetchSummary).not.toHaveBeenCalledWith(2);
  });

  it('drops entries whose fetch returns null or throws (never crashes the rail)', async () => {
    const known = new Map<number, CollectionSummary>();
    const fetchSummary = vi.fn(async (id: number) => {
      if (id === 1) return summary({ id: 1, name: 'One' });
      if (id === 2) return null; // hidden / unresolvable
      throw new Error('boom'); // id 3 fetch error
    });
    const resolved = await resolvePopularEntries(entries, known, fetchSummary);
    expect(resolved.map((r) => r.collection.id)).toEqual([1]);
  });

  it('handles a large (>200) ranked set without dropping resolvable ids', async () => {
    const big: PopularEntry[] = Array.from({ length: 250 }, (_, i) => ({ collectionId: i + 1, count: 250 - i }));
    const known = new Map<number, CollectionSummary>();
    const fetchSummary = vi.fn(async (id: number) => summary({ id, name: `C${id}` }));
    const resolved = await resolvePopularEntries(big, known, fetchSummary);
    expect(resolved).toHaveLength(250);
    // Rank order (count-desc == the input order) is preserved.
    expect(resolved[0].collection.id).toBe(1);
    expect(resolved[249].collection.id).toBe(250);
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
