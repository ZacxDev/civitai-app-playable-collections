// In-memory fake of `ApiClient` for TESTS and the DEV HARNESS ONLY. The SDK's
// mock host does not answer the block HTTP endpoints (collections, tip, follow),
// so there is no real backend in a vitest/jsdom run or a local dev harness. This
// double implements the SAME `ApiClient` interface the real
// `createHttpApiClient()` returns, so the app's network boundary is exercised
// end-to-end without a live server.
//
// NOT imported by production code — `App.tsx` builds the real HTTP client from
// `useBlockToken()`. It mirrors the documented endpoint semantics the app relies
// on: self-tip rejection, insufficient-balance rejection, and follow toggling.
//
// NOTE: Buzz balance and the cross-user "popular" play-counts are NO LONGER part
// of the ApiClient — they go through the host bridges (`useBuzzBalance()` /
// `useSharedStorage()`), which the SDK mock host answers directly (seed via the
// `<Harness buzzBalance=… shared=…>` props in tests). So the fake models neither.

import { ApiError, type ApiClient } from './lib/api.js';
import { PERIOD_WIRE, isRankedWindow, type CollectionPeriod } from './lib/period.js';
import type {
  CollectionPage,
  CollectionSummary,
  ListCollectionsParams,
  MediaItem,
  Page,
  TipAllowance,
  TipInput,
  TipResult,
} from './types.js';

export interface FakeApiOptions {
  /** The signed-in viewer's userId (to exercise self-tip disabling). */
  viewerUserId?: number;
  /** Starting Buzz balance. Default 5000. */
  balance?: number;
  /** The viewer's daily tip ceiling, as the server would report it. Default 25000. */
  tipDailyCap?: number;
  /** Buzz already tipped today before this fake starts. Default 0. */
  tipSpentToday?: number;
  /** Seed collections; a curated default set is used when omitted. */
  collections?: SeedCollection[];
  /** Force every mutating call to fail with this code (to test error UI). */
  failMode?: 'none' | 'forbidden' | 'rate_limited' | 'insufficient_balance' | 'not_found';
  /**
   * Models the SERVER's consent gate for `collections:read:private`: when this
   * returns false, `mode=mine` omits the viewer's PRIVATE collections (the same
   * way the real server withholds them until the scope is on the token). A
   * private-detail `getCollection` also 404s. Default: private granted (true),
   * so tests unconcerned with consent see the full set.
   */
  collectionsPrivateGranted?: () => boolean;
  /**
   * Model the server FAILING to serve a ranked window (ClickHouse unavailable):
   * a `period=Day|Week|Month|Year` request comes back from Postgres, in the
   * UNWINDOWED order, reporting `source: 'postgres'` +
   * `sourceReason: 'clickhouse-unavailable'`.
   *
   * This is the one branch the UI's fallback note exists for, and it cannot be
   * produced by asking the real server nicely — so it is a fixture.
   */
  listWindowUnavailable?: boolean;
}

export interface SeedCollection {
  summary: CollectionSummary;
  items: MediaItem[];
  /**
   * Per-window follower counts the fake ranks `sort=popular` by, highest first.
   *
   * 🔴 THE FAKE REALLY REORDERS — recording the param would be worthless. A
   * period selector whose only proof is "the request carried `period=Week`" is
   * the "wire terminated at both ends and never energised" shape this app has
   * already shipped once; the thing a viewer sees is the ORDER, so the double
   * has to be able to produce a different one and a test has to assert on the
   * resulting ids.
   *
   * 🔴 OPT-IN, AND THAT IS LOAD-BEARING: when NO seed in the set declares
   * `popularity`, the fake keeps insertion order exactly as it always has. Every
   * existing fixture predates this field, and the app now sends `period=Month`
   * on every discover load — so ranking unconditionally would silently reorder
   * the lists under ~660 tests that never opted into caring.
   */
  popularity?: Partial<Record<CollectionPeriod, number>>;
}

/** Extra test hooks exposed alongside the ApiClient surface. */
export interface FakeApi extends ApiClient {
  __balance(): number;
  __isFollowed(collectionId: number): boolean;
  __tips(): TipInput[];
  /** Buzz this fake has recorded against today's allowance. */
  __tipSpentToday(): number;
}

function makeSeed(): SeedCollection[] {
  const mk = (
    id: number,
    name: string,
    curator: { userId: number; username: string },
    isPublic: boolean,
    items: MediaItem[],
  ): SeedCollection => ({
    summary: {
      id,
      name,
      description: `${name} — a curated set.`,
      coverImageUrl: items[0]?.url ?? null,
      itemCount: items.length,
      curator,
      isPublic,
      followed: false,
      // Cover gated by the highest-rated item (mirrors the server contract).
      coverNsfwLevel: items.length ? Math.max(...items.map((it) => it.nsfwLevel)) : undefined,
    },
    items,
  });
  const img = (mediaId: number, creator: { userId: number; username: string }): MediaItem => ({
    mediaId,
    type: 'image',
    url: `https://example.invalid/i/${mediaId}.jpg`,
    width: 1024,
    height: 1024,
    creator,
    nsfwLevel: 1,
  });
  const vid = (mediaId: number, creator: { userId: number; username: string }): MediaItem => ({
    mediaId,
    type: 'video',
    url: `https://example.invalid/v/${mediaId}.mp4`,
    width: 1280,
    height: 720,
    creator,
    nsfwLevel: 1,
  });
  const alice = { userId: 11, username: 'alice' };
  const bob = { userId: 22, username: 'bob' };
  const me = { userId: 99, username: 'me' };
  return [
    mk(101, 'Neon Cities', alice, true, [img(1001, bob), vid(1002, alice), img(1003, bob)]),
    mk(102, 'Forest Studies', bob, true, [img(1004, alice), img(1005, bob)]),
    // viewer 99's OWN collections: one public, one private (consent-gated).
    mk(201, 'My Public Board', me, true, [img(1006, alice)]),
    mk(202, 'My Private Board', me, false, [img(1007, bob)]),
  ];
}

export function createFakeApi(opts: FakeApiOptions = {}): FakeApi {
  const viewerUserId = opts.viewerUserId ?? 99;
  let balance = opts.balance ?? 5000;
  const seeds = opts.collections ?? makeSeed();
  const byId = new Map<number, SeedCollection>(seeds.map((s) => [s.summary.id, s]));
  const followed = new Map<number, boolean>(seeds.map((s) => [s.summary.id, s.summary.followed]));
  const tips: TipInput[] = [];
  /** Replay store for idempotent tips: key -> the first terminal result. */
  const tipsByKey = new Map<string, TipResult>();
  const tipDailyCap = opts.tipDailyCap ?? 25000;
  let tipSpentToday = opts.tipSpentToday ?? 0;
  const fail = opts.failMode ?? 'none';
  const privateGranted = opts.collectionsPrivateGranted ?? (() => true);

  function guardFail() {
    switch (fail) {
      case 'forbidden':
        throw new ApiError('forbidden', 403, 'You do not have permission to do that.');
      case 'rate_limited':
        throw new ApiError('rate_limited', 429, 'Too many requests.', 2000);
      case 'not_found':
        throw new ApiError('not_found', 404, 'Not found.');
      case 'insufficient_balance':
        throw new ApiError('insufficient_balance', 403, 'Not enough Buzz.');
      default:
        break;
    }
  }

  function summaryFor(s: SeedCollection): CollectionSummary {
    return { ...s.summary, followed: followed.get(s.summary.id) ?? false };
  }

  /**
   * Apply the popularity window, and report the provenance the real endpoint
   * reports. Mirrors the LIVE contract measured 2026-09-11 (the table in
   * lib/period.ts), because a double that is more forgiving than production is
   * how a UI ships a branch nothing ever exercised:
   *
   *   - no `period`            -> no `source`/`period`/`sourceReason` keys at all
   *                               (also what a host predating the param returns)
   *   - `sort` !== 'popular'   -> accepted, IGNORED, `postgres` +
   *                               `period-ignored-for-non-popularity-sort`
   *   - `allTime`              -> `postgres` + `all-time-served-from-postgres`,
   *                               unwindowed order — a HEALTHY response
   *   - `day|week|month|year`  -> `clickhouse`, ranked by `popularity[period]`
   *   - …unless `listWindowUnavailable`, which downgrades that last case to
   *     `postgres` + `clickhouse-unavailable` in the UNWINDOWED order
   */
  function rankByWindow(
    list: SeedCollection[],
    params: ListCollectionsParams,
  ): { items: SeedCollection[]; source?: string; period?: string; sourceReason?: string } {
    const period = params.period;
    if (period == null) return { items: list };

    const wire = PERIOD_WIRE[period];
    if (params.sort !== 'popular') {
      return { items: list, source: 'postgres', period: wire, sourceReason: 'period-ignored-for-non-popularity-sort' };
    }
    if (!isRankedWindow(period)) {
      return { items: list, source: 'postgres', period: wire, sourceReason: 'all-time-served-from-postgres' };
    }
    if (opts.listWindowUnavailable) {
      return { items: list, source: 'postgres', period: wire, sourceReason: 'clickhouse-unavailable' };
    }
    // Ranked. Descending by this window's follower count; ties broken by id
    // ascending so the order is total and a test can pin it literally.
    const declaresPopularity = list.some((s) => s.popularity != null);
    const items = declaresPopularity
      ? [...list].sort((a, b) => {
          const d = (b.popularity?.[period] ?? 0) - (a.popularity?.[period] ?? 0);
          return d !== 0 ? d : a.summary.id - b.summary.id;
        })
      : list;
    return { items, source: 'clickhouse', period: wire };
  }

  return {
    async listCollections(params: ListCollectionsParams): Promise<Page<CollectionSummary>> {
      let list = seeds.filter((s) => {
        if (params.mode === 'public') return s.summary.isPublic;
        // mode=mine: the viewer's own collections. PRIVATE ones are omitted by
        // the server until the `collections:read:private` scope is on the token.
        if (s.summary.curator.userId !== viewerUserId) return false;
        return s.summary.isPublic || privateGranted();
      });
      if (params.query) {
        const q = params.query.toLowerCase();
        list = list.filter((s) => s.summary.name.toLowerCase().includes(q));
      }
      // The fake keeps taking the friendly UI values ('newest'/'popular',
      // 'day'…'allTime'); only the real HTTP client translates to the server's
      // enums.
      //
      // Ranking is OPT-IN: a seed set that declares no `popularity` keeps
      // insertion order, exactly as this fake always has, so every pre-existing
      // fixture is untouched by the period default.
      const ranked = rankByWindow(list, params);
      return { ...ranked, items: ranked.items.map(summaryFor) };
    },

    async getCollection(id: number): Promise<CollectionPage> {
      const s = byId.get(id);
      if (!s) throw new ApiError('not_found', 404, 'That collection could not be found.');
      // Private detail 404s until the private-read scope is on the token (server
      // parity) — unless the viewer owns it AND has the scope granted.
      if (!s.summary.isPublic && !privateGranted()) {
        throw new ApiError('not_found', 404, 'That collection could not be found.');
      }
      return {
        collection: {
          id: s.summary.id,
          name: s.summary.name,
          description: s.summary.description,
          curator: s.summary.curator,
          isPublic: s.summary.isPublic,
          followed: followed.get(id) ?? false,
        },
        items: s.items,
      };
    },

    async tip(input: TipInput): Promise<TipResult> {
      guardFail();
      if (input.toUserId === viewerUserId) {
        throw new ApiError('forbidden', 403, 'You cannot tip yourself.');
      }
      if (!Number.isInteger(input.amount) || input.amount <= 0) {
        throw new ApiError('unknown', 400, 'Tip amount must be a positive whole number.');
      }
      // Idempotency, mirrored from the server: a repeated key REPLAYS the first
      // terminal result instead of transferring again. Without this the fake is
      // MORE permissive than production, so a double-send bug would pass here
      // and double-spend live — the exact drift a fake exists to prevent.
      if (input.idempotencyKey != null) {
        const prior = tipsByKey.get(input.idempotencyKey);
        if (prior) return prior;
      }
      if (input.amount > balance) {
        throw new ApiError('insufficient_balance', 403, 'Not enough Buzz for that tip.');
      }
      balance -= input.amount;
      tips.push(input);
      tipSpentToday += input.amount;
      const res: TipResult = { ok: true, tip: { amount: input.amount, toUserId: input.toUserId } };
      if (input.idempotencyKey != null) tipsByKey.set(input.idempotencyKey, res);
      return res;
    },

    async getTipAllowance(): Promise<TipAllowance> {
      guardFail();
      return { cap: tipDailyCap, spent: tipSpentToday, remaining: Math.max(0, tipDailyCap - tipSpentToday) };
    },

    __balance: () => balance,
    __tipSpentToday: () => tipSpentToday,
    __isFollowed: (id: number) => followed.get(id) ?? false,
    __tips: () => tips,
  };
}
