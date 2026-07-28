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
// - A `setFollow` mutation clears the caches (a collection's `followed` flag lives
//   in both the list and detail payloads), so post-follow reads are fresh.
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

export function createCachedApiClient(inner: ApiClient, opts: CacheOptions = {}): ApiClient {
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

    async setFollow(id, follow) {
      const res = await inner.setFollow(id, follow);
      // The followed flag is embedded in cached list + detail payloads → drop them.
      clearReads();
      return res;
    },

    tip: (input) => inner.tip(input),
  };
}
