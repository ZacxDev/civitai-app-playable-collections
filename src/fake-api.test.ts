import { describe, expect, it } from 'vitest';

import { createFakeApi, type SeedCollection } from './fake-api.js';
import type { CollectionSummary } from './types.js';

// 🔴 WHAT THIS FILE IS FOR. `fake-api.ts` is the ONLY backend the suite and the
// dev harness ever see, so a double that is more forgiving than production is how
// a branch ships having been exercised by nothing. Every expectation below is
// transcribed from a LIVE reading of `GET /api/v1/blocks/collections` on
// 2026-09-11 (the table at the top of `lib/period.ts`) — not from the fake's own
// source, which is the thing under test.

const summary = (id: number, name: string): CollectionSummary => ({
  id,
  name,
  description: null,
  coverImageUrl: null,
  itemCount: 1,
  curator: { userId: 11, username: 'alice' },
  isPublic: true,
  followed: false,
});

/** Two public seeds whose windows disagree, so an order assertion discriminates. */
const seeds = (): SeedCollection[] => [
  { summary: summary(301, 'Alpha'), items: [], popularity: { day: 1, week: 2, month: 1, year: 2 } },
  { summary: summary(302, 'Bravo'), items: [], popularity: { day: 2, week: 1, month: 2, year: 1 } },
];

const ids = (p: { items: CollectionSummary[] }) => p.items.map((i) => i.id);

describe('the fake reports the provenance the live endpoint reports', () => {
  const api = () => createFakeApi({ viewerUserId: 11, collections: seeds() });

  it('a ranked window is served from clickhouse, with no reason', async () => {
    const page = await api().listCollections({ mode: 'public', sort: 'popular', period: 'month' });
    expect(page.source).toBe('clickhouse');
    expect(page.period).toBe('Month');
    expect(page.sourceReason).toBeUndefined();
    expect(ids(page)).toEqual([302, 301]);
  });

  it('AllTime is served from postgres in the unwindowed order — a HEALTHY response', async () => {
    const page = await api().listCollections({ mode: 'public', sort: 'popular', period: 'allTime' });
    expect(page.source).toBe('postgres');
    expect(page.period).toBe('AllTime');
    expect(page.sourceReason).toBe('all-time-served-from-postgres');
    expect(ids(page)).toEqual([301, 302]); // insertion order, not ranked
  });

  it('🔴 an ABSENT period reports no provenance at all — the pre-`period` host shape', async () => {
    const page = await api().listCollections({ mode: 'public', sort: 'popular' });
    expect(page.source).toBeUndefined();
    expect(page.period).toBeUndefined();
    expect(page.sourceReason).toBeUndefined();
    expect(ids(page)).toEqual([301, 302]);
  });

  it('the newest sort accepts and ignores the window', async () => {
    const page = await api().listCollections({ mode: 'public', sort: 'newest', period: 'week' });
    expect(page.source).toBe('postgres');
    expect(page.sourceReason).toBe('period-ignored-for-non-popularity-sort');
    expect(ids(page)).toEqual([301, 302]);
  });

  it('🔴 mode=mine accepts and ignores the window — with its OWN reason', async () => {
    // This is the row that caught a real defect: a ranked window answered by
    // Postgres is indistinguishable at the consumer from ClickHouse being down,
    // so a UI keyed on `source` alone hangs a false outage note on this tab. App
    // sends no period here, which makes this branch unreachable from the UI —
    // modelled anyway so the double can never be MORE permissive than production.
    const page = await api().listCollections({ mode: 'mine', sort: 'popular', period: 'month' });
    expect(page.source).toBe('postgres');
    expect(page.period).toBe('Month');
    expect(page.sourceReason).toBe('period-ignored-outside-public-discovery');
    expect(ids(page)).toEqual([301, 302]); // NOT ranked, and nothing hidden
  });

  it('mode=mine + AllTime reports the ALL-TIME reason, not the mine one', async () => {
    // Measured live — the two "ignored" cases do not collide, and the order the
    // branches are written in is what decides it.
    const page = await api().listCollections({ mode: 'mine', sort: 'popular', period: 'allTime' });
    expect(page.sourceReason).toBe('all-time-served-from-postgres');
  });

  it('models ClickHouse being unavailable: postgres + the unwindowed order', async () => {
    const api2 = createFakeApi({ viewerUserId: 11, collections: seeds(), listWindowUnavailable: true });
    const page = await api2.listCollections({ mode: 'public', sort: 'popular', period: 'month' });
    expect(page.source).toBe('postgres');
    expect(page.sourceReason).toBe('clickhouse-unavailable');
    expect(ids(page)).toEqual([301, 302]); // the all-time order, as the server would
  });
});

describe('ranking is opt-in, which is what leaves the existing fixtures alone', () => {
  it('🔴 a seed set declaring NO popularity keeps insertion order', async () => {
    // Every fixture in this repo predates the `popularity` field, and the app now
    // sends `period=Month` on every discover load. Ranking unconditionally would
    // have silently reordered the lists under hundreds of tests that never opted
    // into caring about order.
    const plain: SeedCollection[] = [
      { summary: summary(502, 'Second'), items: [] },
      { summary: summary(501, 'First'), items: [] },
    ];
    const api = createFakeApi({ viewerUserId: 11, collections: plain });
    const page = await api.listCollections({ mode: 'public', sort: 'popular', period: 'month' });
    // Insertion order — NOT sorted by id, which is what a naive total order would
    // have produced here and is why these two ids are deliberately descending.
    expect(ids(page)).toEqual([502, 501]);
    // …while still reporting the provenance, so the two concerns stay separable.
    expect(page.source).toBe('clickhouse');
  });

  it('breaks ties by id so a ranked order is total and pinnable', async () => {
    const tied: SeedCollection[] = [
      { summary: summary(604, 'D'), items: [], popularity: { month: 5 } },
      { summary: summary(603, 'C'), items: [], popularity: { month: 5 } },
      { summary: summary(602, 'B'), items: [], popularity: { month: 9 } },
    ];
    const api = createFakeApi({ viewerUserId: 11, collections: tied });
    const page = await api.listCollections({ mode: 'public', sort: 'popular', period: 'month' });
    expect(ids(page)).toEqual([602, 603, 604]);
  });

  it('a window a seed does not declare scores 0 rather than throwing', async () => {
    const partial: SeedCollection[] = [
      { summary: summary(701, 'Has year'), items: [], popularity: { year: 3 } },
      { summary: summary(702, 'Has day'), items: [], popularity: { day: 7 } },
    ];
    const api = createFakeApi({ viewerUserId: 11, collections: partial });
    const byDay = await api.listCollections({ mode: 'public', sort: 'popular', period: 'day' });
    expect(ids(byDay)).toEqual([702, 701]);
    const byYear = await api.listCollections({ mode: 'public', sort: 'popular', period: 'year' });
    expect(ids(byYear)).toEqual([701, 702]);
  });
});
