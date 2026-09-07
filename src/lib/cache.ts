// Session (in-memory) cache wrapper for the read paths of `ApiClient`.
//
// Feedback #3: the block collection endpoints are intentionally `private,
// no-store` at the HTTP layer (per-subject), which is correct — we do NOT change
// that. Instead the APP caches the *decoded* list + detail responses in memory so
// re-navigation (switching tabs, closing and re-opening a collection) is instant
// and doesn't re-hit the origin. Image/media (CDN) URLs are unaffected and keep
// browser-caching normally.
//
// - Only the READ methods are cached: `listCollections` (keyed by its params) and
//   `getCollection` (keyed by id + cursor + limit — so the paginated player fetch
//   re-uses each page on re-open).
// - In-flight requests are DEDUPED (the Promise is cached); a rejection is never
//   cached (the entry is dropped) so a transient failure can be retried.
// - 🔴 FOLLOW INVALIDATION IS NOW A CALLER OBLIGATION, NOT A WRAPPED METHOD, and
//   that change is easy to miss. A collection's `followed` flag is embedded in
//   BOTH the list and detail payloads, so a follow write must drop these caches
//   or re-opening the collection serves the pre-follow flag. Until 0.2.10 this
//   wrapper got that for free by intercepting `setFollow`. Following now goes
//   through the HOST BRIDGE and never touches this client, so there is nothing
//   left to intercept — the cache would have gone silently stale, with the
//   grid badge and the player disagreeing after a re-open. `invalidateReads()`
//   is the replacement, and App calls it from the follow `onChange`.
// - Entries expire after `ttlMs` (default 5 min) to bound staleness.
// - The one remaining write method (`tip`) passes straight through. Buzz balance
//   and shared play-counts are no longer on this client — they go through the
//   `useBuzzBalance()` / `useSharedStorage()` host bridges (see lib/popular.ts).

import type { ApiClient } from './api.js';
import type {
  CollectionPage,
  CollectionSummary,
  ListCollectionsParams,
  Page,
} from '../types.js';

export interface CacheOptions {
  /** Entry time-to-live in ms. Default 5 minutes. */
  ttlMs?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
}

interface Entry<T> {
  at: number;
  value: Promise<T>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** An `ApiClient` whose cached reads can be dropped explicitly. */
export interface CachedApiClient extends ApiClient {
  /** Drop the cached list + detail reads (see the follow note in the header). */
  invalidateReads(): void;
}

export function createCachedApiClient(inner: ApiClient, opts: CacheOptions = {}): CachedApiClient {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  const listCache = new Map<string, Entry<Page<CollectionSummary>>>();
  const detailCache = new Map<string, Entry<CollectionPage>>();

  function fresh<T>(cache: Map<string, Entry<T>>, key: string): Promise<T> | undefined {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (now() - hit.at > ttlMs) {
      cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  function remember<T>(cache: Map<string, Entry<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const value = load();
    cache.set(key, { at: now(), value });
    // Never cache a rejected promise — drop the entry so the next call retries.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  }

  function clearReads() {
    listCache.clear();
    detailCache.clear();
  }

  return {
    listCollections(params: ListCollectionsParams) {
      const key = JSON.stringify({
        mode: params.mode,
        query: params.query ?? '',
        sort: params.sort ?? '',
        cursor: params.cursor ?? '',
        limit: params.limit ?? '',
      });
      return fresh(listCache, key) ?? remember(listCache, key, () => inner.listCollections(params));
    },

    getCollection(id, o) {
      const key = `${id}:${o?.cursor ?? ''}:${o?.limit ?? ''}`;
      return fresh(detailCache, key) ?? remember(detailCache, key, () => inner.getCollection(id, o));
    },

    tip: (input) => inner.tip(input),

    getTipAllowance: () => inner.getTipAllowance(),

    /**
     * Drop the cached list + detail reads. Call after ANY mutation that changes
     * a field embedded in them — today that is exactly one thing: a follow
     * write, which now happens over the host bridge rather than through this
     * client.
     */
    invalidateReads: clearReads,
  };
}
