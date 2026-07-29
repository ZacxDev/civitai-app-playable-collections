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
import type {
  CollectionPage,
  CollectionSummary,
  ListCollectionsParams,
  MediaItem,
  Page,
  TipInput,
  TipResult,
} from './types.js';

export interface FakeApiOptions {
  /** The signed-in viewer's userId (to exercise self-tip disabling). */
  viewerUserId?: number;
  /** Starting Buzz balance. Default 5000. */
  balance?: number;
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
}

export interface SeedCollection {
  summary: CollectionSummary;
  items: MediaItem[];
}

/** Extra test hooks exposed alongside the ApiClient surface. */
export interface FakeApi extends ApiClient {
  __balance(): number;
  __isFollowed(collectionId: number): boolean;
  __tips(): TipInput[];
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
      // The fake keeps taking the friendly UI sort values ('newest'/'popular');
      // only the real HTTP client translates to the server's enum. The server's
      // 'popular' = "Most Followers"; the fake has no follower data, so it keeps
      // insertion order (no test asserts the fake's popular ordering).
      return { items: list.map(summaryFor) };
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

    async setFollow(id: number, follow: boolean): Promise<{ followed: boolean }> {
      guardFail();
      if (!byId.has(id)) throw new ApiError('not_found', 404, 'Not found.');
      followed.set(id, follow);
      return { followed: follow };
    },

    async tip(input: TipInput): Promise<TipResult> {
      guardFail();
      if (input.toUserId === viewerUserId) {
        throw new ApiError('forbidden', 403, 'You cannot tip yourself.');
      }
      if (!Number.isInteger(input.amount) || input.amount <= 0) {
        throw new ApiError('unknown', 400, 'Tip amount must be a positive whole number.');
      }
      if (input.amount > balance) {
        throw new ApiError('insufficient_balance', 403, 'Not enough Buzz for that tip.');
      }
      balance -= input.amount;
      tips.push(input);
      return { ok: true, tip: { amount: input.amount, toUserId: input.toUserId } };
    },

    __balance: () => balance,
    __isFollowed: (id: number) => followed.get(id) ?? false,
    __tips: () => tips,
  };
}
