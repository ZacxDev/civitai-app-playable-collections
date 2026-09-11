import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './api.js';
import type { CollectionPage, CollectionSummary, Page } from '../types.js';
import { createCachedApiClient } from './cache.js';

function summary(id: number): CollectionSummary {
  return {
    id,
    name: `c${id}`,
    description: null,
    coverImageUrl: null,
    itemCount: 0,
    curator: { userId: 1, username: 'a' },
    isPublic: true,
    followed: false,
  };
}

function detailPage(id: number): CollectionPage {
  return {
    collection: {
      id,
      name: `c${id}`,
      description: null,
      curator: { userId: 1, username: 'a' },
      isPublic: true,
      followed: false,
    },
    items: [],
    nextCursor: undefined,
  };
}

/** A minimal inner ApiClient whose read methods count how often they're hit. */
function makeInner() {
  const listImpl = vi.fn(async (): Promise<Page<CollectionSummary>> => ({ items: [summary(1)] }));
  const getImpl = vi.fn(async (id: number): Promise<CollectionPage> => detailPage(id));
  const tipImpl = vi.fn(async () => ({ ok: true as const }));
  const allowanceImpl = vi.fn(async () => ({ cap: 25000, spent: 0, remaining: 25000 }));
  const inner = {
    listCollections: listImpl,
    getCollection: getImpl,
    tip: tipImpl,
    getTipAllowance: allowanceImpl,
  } as unknown as ApiClient;
  return { inner, listImpl, getImpl, tipImpl, allowanceImpl };
}

describe('createCachedApiClient', () => {
  it('serves a repeated listCollections from cache (one origin hit)', async () => {
    const { inner, listImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.listCollections({ mode: 'public', sort: 'popular', limit: 24 });
    await api.listCollections({ mode: 'public', sort: 'popular', limit: 24 });
    expect(listImpl).toHaveBeenCalledTimes(1);
  });

  it('keys listCollections by params — different params miss the cache', async () => {
    const { inner, listImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.listCollections({ mode: 'public', sort: 'popular' });
    await api.listCollections({ mode: 'public', sort: 'newest' });
    await api.listCollections({ mode: 'mine', sort: 'popular' });
    expect(listImpl).toHaveBeenCalledTimes(3);
  });

  it('🔴 keys listCollections by PERIOD — switching the window is never a cache hit', async () => {
    // The window changes the ORDER of the rows and nothing else: same mode, same
    // query, same sort, same limit. A key that omitted `period` would therefore
    // serve the PREVIOUS window's rows and the period control would look inert —
    // and INTERMITTENTLY so, since the entry expires after `ttlMs` and the very
    // same click works five minutes later.
    const { inner, listImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.listCollections({ mode: 'public', sort: 'popular', period: 'month', limit: 24 });
    await api.listCollections({ mode: 'public', sort: 'popular', period: 'week', limit: 24 });
    await api.listCollections({ mode: 'public', sort: 'popular', period: 'allTime', limit: 24 });
    expect(listImpl).toHaveBeenCalledTimes(3);
  });

  it('still caches a REPEATED window (the period key does not defeat caching)', async () => {
    // The positive control for the case above: if the key were made unique per
    // call the test above would pass while caching was broken outright.
    const { inner, listImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.listCollections({ mode: 'public', sort: 'popular', period: 'month', limit: 24 });
    await api.listCollections({ mode: 'public', sort: 'popular', period: 'month', limit: 24 });
    expect(listImpl).toHaveBeenCalledTimes(1);
  });

  it('distinguishes NO period from an explicit one', async () => {
    // A pre-`period` request and a windowed one are different responses.
    const { inner, listImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.listCollections({ mode: 'public', sort: 'popular' });
    await api.listCollections({ mode: 'public', sort: 'popular', period: 'month' });
    expect(listImpl).toHaveBeenCalledTimes(2);
  });

  it('serves a repeated getCollection page from cache, keyed by id+cursor+limit', async () => {
    const { inner, getImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.getCollection(5, { limit: 100 });
    await api.getCollection(5, { limit: 100 }); // cache hit
    await api.getCollection(5, { cursor: 'c1', limit: 100 }); // different page → miss
    expect(getImpl).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent identical reads into a single in-flight request', async () => {
    const { inner, listImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await Promise.all([
      api.listCollections({ mode: 'public' }),
      api.listCollections({ mode: 'public' }),
    ]);
    expect(listImpl).toHaveBeenCalledTimes(1);
  });

  it('a rejected read is NOT cached — the next call retries', async () => {
    const inner = {
      listCollections: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ items: [] }),
      getCollection: vi.fn(),
      setFollow: vi.fn(),
      tip: vi.fn(),
    } as unknown as ApiClient;
    const api = createCachedApiClient(inner);
    await expect(api.listCollections({ mode: 'public' })).rejects.toThrow('boom');
    await expect(api.listCollections({ mode: 'public' })).resolves.toEqual({ items: [] });
    expect(inner.listCollections).toHaveBeenCalledTimes(2);
  });

  it('invalidateReads() drops BOTH read caches (post-follow reads are fresh)', async () => {
    const { inner, listImpl, getImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.listCollections({ mode: 'public' });
    await api.getCollection(5, { limit: 100 });
    // Was `api.setFollow(5, true)` until 0.2.10. Following moved to the host
    // bridge and never reaches this client, so the invalidation it used to get
    // for free is now an explicit call the caller owes — App makes it from the
    // follow `onChange`.
    api.invalidateReads();
    await api.listCollections({ mode: 'public' }); // cache cleared → re-fetch
    await api.getCollection(5, { limit: 100 }); // cache cleared → re-fetch
    expect(listImpl).toHaveBeenCalledTimes(2);
    expect(getImpl).toHaveBeenCalledTimes(2);
  });

  it('WITHOUT invalidateReads a stale followed flag would be served — the control', async () => {
    // 🔴 The negative arm. Without it the test above passes even if
    // `invalidateReads` were a no-op and the caches simply never cached.
    const { inner, listImpl, getImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.listCollections({ mode: 'public' });
    await api.getCollection(5, { limit: 100 });
    await api.listCollections({ mode: 'public' });
    await api.getCollection(5, { limit: 100 });
    expect(listImpl).toHaveBeenCalledTimes(1);
    expect(getImpl).toHaveBeenCalledTimes(1);
  });

  it('expires an entry after ttlMs', async () => {
    const { inner, listImpl } = makeInner();
    let t = 1000;
    const api = createCachedApiClient(inner, { ttlMs: 100, now: () => t });
    await api.listCollections({ mode: 'public' });
    t = 1050; // within ttl → cache hit
    await api.listCollections({ mode: 'public' });
    expect(listImpl).toHaveBeenCalledTimes(1);
    t = 1200; // past ttl → miss
    await api.listCollections({ mode: 'public' });
    expect(listImpl).toHaveBeenCalledTimes(2);
  });

  it('passes non-read methods straight through', async () => {
    const { inner, tipImpl, allowanceImpl } = makeInner();
    const api = createCachedApiClient(inner);
    await api.tip({ toUserId: 9, amount: 10 });
    expect(tipImpl).toHaveBeenCalledWith({ toUserId: 9, amount: 10 });
    // 🔴 The allowance must NOT be cached: it changes on every tip, and serving
    // a stale one is how a viewer gets refused for Buzz they actually have.
    await api.getTipAllowance();
    await api.getTipAllowance();
    expect(allowanceImpl).toHaveBeenCalledTimes(2);
  });
});
