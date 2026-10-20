import { describe, expect, it, vi } from 'vitest';

import { createFakeStorage } from '@civitai/sdk/testing';

import {
  PLAYED_MARK,
  PLAYS_COUNTER,
  POPULAR_MIN_ENTRIES,
  POPULAR_MIN_PLAYS,
  POPULAR_PLAYS_COLLECTION,
  popularRailEntries,
  readPopular,
  readPopularDoc,
  recordPlay,
  recordPlayDoc,
  resolvePopularEntries,
  summaryFromPage,
  totalBuzz,
  type PlaysStore,
} from './popular.js';
import { manifest } from '../manifest.js';
import type { CollectionPage, CollectionSummary, PopularEntry } from '../types.js';

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

/**
 * The document store, via the SDK's OWN fake (`createFakeStorage`) — the
 * platform's in-memory enforcement of the server's rules (declaration,
 * write policies, mark idempotence, error codes), not a hand-rolled stand-in
 * whose semantics would be mine to get wrong.
 *
 * 🔴 THE FAKE IS BUILT FROM THE COMMITTED MANIFEST, and that is the drift
 * guard for `POPULAR_PLAYS_COLLECTION`: production code names the collection
 * by the constant, the fake knows only what `block.manifest.json` declares,
 * so renaming one without the other turns every case below red with
 * `collection_not_declared` instead of silently testing a phantom store.
 */
function makeFakePlays() {
  const fake = createFakeStorage({
    manifest: {
      scopes: manifest.scopes as string[],
      storage: manifest.storage,
    },
    viewer: { username: 'alice' },
  });
  return {
    fake,
    /** The collection handle as one viewer (default: alice, the fake's own). */
    as: (username?: string): PlaysStore =>
      (username === undefined
        ? fake.storage
        : fake.as({ viewer: { username } }).storage
      ).collection(POPULAR_PLAYS_COLLECTION) as PlaysStore,
  };
}

describe('the declared collection refuses document writes (write: "none" is load-bearing)', () => {
  it('rejects put/create, so popularity can only ever move by tally', async () => {
    const { fake } = makeFakePlays();
    // The full handle, not the PlaysStore slice: the slice exists precisely
    // because these two methods are refused by the declaration.
    const full = fake.storage.collection(POPULAR_PLAYS_COLLECTION);
    const code = async (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: unknown) => (e as { code?: string }).code ?? 'threw',
      );
    expect(await code(full.put('101', {}))).toBe('write_policy');
    expect(await code(full.create({}))).toBe('write_policy');
  });

  it('refuses a mark on a key with no document — the reason recordPlayDoc increments first', async () => {
    const { as } = makeFakePlays();
    await expect(as().mark('101', PLAYED_MARK)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('recordPlayDoc', () => {
  it('creates the document and counts the first play as one distinct viewer', async () => {
    const { as } = makeFakePlays();
    await recordPlayDoc(as(), { id: 101 });
    expect(await readPopularDoc(as(), 10)).toEqual([{ collectionId: 101, count: 1 }]);
  });

  it('counts DISTINCT viewers: a second viewer raises the count, a replay does not', async () => {
    const { as } = makeFakePlays();
    await recordPlayDoc(as('alice'), { id: 101 });
    await recordPlayDoc(as('bob'), { id: 101 });
    await recordPlayDoc(as('alice'), { id: 101 }); // replay
    expect(await readPopularDoc(as(), 10)).toEqual([{ collectionId: 101, count: 2 }]);
  });

  it('the raw counter tallies EVERY play while the mark counts viewers — and only the mark ranks', async () => {
    const { as } = makeFakePlays();
    await recordPlayDoc(as('alice'), { id: 101 });
    await recordPlayDoc(as('alice'), { id: 101 });
    const page = await as().list();
    // The divergence is the design, pinned so nobody "fixes" the rail onto
    // the counter: plays=2 (both plays), played=1 (one viewer).
    expect(page.items[0].counters[PLAYS_COUNTER]).toBe(2);
    expect(page.items[0].marks[PLAYED_MARK]).toBe(1);
    expect(await readPopularDoc(as(), 10)).toEqual([{ collectionId: 101, count: 1 }]);
  });
});

describe('readPopularDoc', () => {
  it('ranks by mark count desc and applies the limit', async () => {
    const { as } = makeFakePlays();
    for (const v of ['a', 'b', 'c']) await recordPlayDoc(as(v), { id: 1 });
    for (const v of ['a', 'b']) await recordPlayDoc(as(v), { id: 2 });
    await recordPlayDoc(as('a'), { id: 3 });
    expect(await readPopularDoc(as(), 10)).toEqual([
      { collectionId: 1, count: 3 },
      { collectionId: 2, count: 2 },
      { collectionId: 3, count: 1 },
    ]);
    expect(await readPopularDoc(as(), 1)).toEqual([{ collectionId: 1, count: 3 }]);
  });

  it('drops a document nobody has marked (increment landed, mark did not)', async () => {
    const { as } = makeFakePlays();
    await as().increment('7', PLAYS_COUNTER); // a torn write: doc exists, zero marks
    await recordPlayDoc(as(), { id: 8 });
    expect(await readPopularDoc(as(), 10)).toEqual([{ collectionId: 8, count: 1 }]);
  });

  it('returns an empty list when nothing has been played', async () => {
    const { as } = makeFakePlays();
    expect(await readPopularDoc(as(), 10)).toEqual([]);
  });
});

describe('recordPlay / readPopular — the app-facing pair, document store only', () => {
  it('record then read round-trips through popular_plays, one distinct viewer per play', async () => {
    const { as } = makeFakePlays();
    await recordPlay(as('alice'), { id: 101 });
    await recordPlay(as('bob'), { id: 101 });
    await recordPlay(as('alice'), { id: 202 });
    expect(await readPopular(as(), 10)).toEqual([
      { collectionId: 101, count: 2 },
      { collectionId: 202, count: 1 },
    ]);
  });

  it('with no store (token lacks apps:storage) records nothing and reads an empty rail', async () => {
    // No request is possible here — there is no store argument to make one
    // through — and there is no legacy store to fall back to any more.
    await expect(recordPlay(null, { id: 101 })).resolves.toBeUndefined();
    expect(await readPopular(null, 10)).toEqual([]);
  });

  it('propagates a store refusal instead of turning it into an empty result', async () => {
    const fake = createFakeStorage({
      manifest: { scopes: manifest.scopes as string[], storage: manifest.storage },
      viewer: { username: 'alice' },
      disabled: true,
    });
    const plays = fake.storage.collection(POPULAR_PLAYS_COLLECTION) as PlaysStore;
    await expect(recordPlay(plays, { id: 101 })).rejects.toMatchObject({ code: 'storage_disabled' });
    await expect(readPopular(plays, 10)).rejects.toMatchObject({ code: 'storage_disabled' });
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
