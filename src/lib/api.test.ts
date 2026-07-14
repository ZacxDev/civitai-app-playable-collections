import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  asMessageString,
  createHttpApiClient,
  parseRetryAfter,
  playCountKey,
} from './api.js';

interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function makeClient(
  responses: Array<Response | (() => Response | Promise<Response>)>,
  opts: { token?: string; refreshToken?: () => Promise<void>; baseUrl?: string } = {},
) {
  const calls: MockCall[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const entry = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return typeof entry === 'function' ? entry() : entry;
  }) as unknown as typeof fetch;

  const api = createHttpApiClient({
    baseUrl: opts.baseUrl ?? '',
    getToken: () => opts.token ?? 'tok_abc',
    refreshToken: opts.refreshToken,
    fetchImpl,
  });
  return { api, calls, fetchImpl };
}

describe('listCollections', () => {
  it('builds the query and returns the page (success)', async () => {
    const { api, calls } = makeClient([
      jsonResponse(200, { items: [{ id: 1, name: 'A' }], nextCursor: 'c2' }),
    ]);
    const page = await api.listCollections({ mode: 'public', query: 'neon', sort: 'popular', limit: 24 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('c2');
    expect(calls[0].url).toContain('/api/v1/blocks/collections');
    expect(calls[0].url).toContain('mode=public');
    expect(calls[0].url).toContain('query=neon');
    // The friendly UI 'popular' is translated to the server's enum on the wire.
    expect(calls[0].url).toContain('sort=Most+Followers');
    expect(calls[0].headers.Authorization).toBe('Bearer tok_abc');
  });

  it('translates the friendly UI sort to the server CollectionSort enum on the wire', async () => {
    const { api, calls } = makeClient([
      jsonResponse(200, { items: [] }),
      jsonResponse(200, { items: [] }),
    ]);
    await api.listCollections({ mode: 'public', sort: 'newest' });
    await api.listCollections({ mode: 'public', sort: 'popular' });
    // URLSearchParams encodes a space as '+'; decode to assert the wire value.
    expect(new URL(calls[0].url, 'http://h').searchParams.get('sort')).toBe('Newest');
    expect(new URL(calls[1].url, 'http://h').searchParams.get('sort')).toBe('Most Followers');
  });

  it('maps 403 -> forbidden', async () => {
    const { api } = makeClient([jsonResponse(403, { error: 'missing scope' })]);
    await expect(api.listCollections({ mode: 'public' })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
  });

  it('maps 429 -> rate_limited with retryAfterMs from Retry-After', async () => {
    const { api } = makeClient([jsonResponse(429, { error: 'slow down' }, { 'Retry-After': '3' })]);
    try {
      await api.listCollections({ mode: 'public' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('rate_limited');
      expect((err as ApiError).retryAfterMs).toBe(3000);
    }
  });
});

describe('getCollection', () => {
  it('returns detail + items on success', async () => {
    const { api, calls } = makeClient([
      jsonResponse(200, {
        collection: { id: 5, name: 'X', curator: { userId: 1, username: 'a' }, isPublic: true, followed: false },
        items: [{ mediaId: 9, type: 'image', url: 'u', width: 1, height: 1, creator: { userId: 2, username: 'b' }, nsfwLevel: 1 }],
      }),
    ]);
    const res = await api.getCollection(5, { limit: 100 });
    expect(res.collection.id).toBe(5);
    expect(res.items[0].mediaId).toBe(9);
    expect(calls[0].url).toContain('/api/v1/blocks/collections/5');
    expect(calls[0].url).toContain('limit=100');
  });

  it('maps 404 -> not_found', async () => {
    const { api } = makeClient([jsonResponse(404, { error: 'gone' })]);
    await expect(api.getCollection(99)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('setFollow', () => {
  it('POSTs the follow flag and returns followed state', async () => {
    const { api, calls } = makeClient([jsonResponse(200, { followed: true })]);
    const res = await api.setFollow(7, true);
    expect(res.followed).toBe(true);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/v1/blocks/collections/7/follow');
    expect(calls[0].body).toEqual({ follow: true });
  });
});

describe('tip', () => {
  it('POSTs the tip body (success)', async () => {
    const { api, calls } = makeClient([jsonResponse(200, { ok: true, tip: { amount: 50, toUserId: 22 } })]);
    const res = await api.tip({ toUserId: 22, amount: 50, entityType: 'Image', entityId: 9 });
    expect(res.ok).toBe(true);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/v1/blocks/tip');
    expect(calls[0].body).toEqual({ toUserId: 22, amount: 50, entityType: 'Image', entityId: 9 });
  });

  it('maps an explicit INSUFFICIENT_BALANCE code -> insufficient_balance', async () => {
    const { api } = makeClient([jsonResponse(403, { code: 'INSUFFICIENT_BALANCE', error: 'no buzz' })]);
    await expect(api.tip({ toUserId: 22, amount: 999999 })).rejects.toMatchObject({
      code: 'insufficient_balance',
    });
  });

  it('maps an insufficient-balance MESSAGE (no code) -> insufficient_balance', async () => {
    const { api } = makeClient([jsonResponse(400, { error: 'Insufficient Buzz balance' })]);
    await expect(api.tip({ toUserId: 22, amount: 999999 })).rejects.toMatchObject({
      code: 'insufficient_balance',
    });
  });

  it('maps a rejected self-tip 403 -> forbidden', async () => {
    const { api } = makeClient([jsonResponse(403, { error: 'cannot tip yourself' })]);
    await expect(api.tip({ toUserId: 1, amount: 10 })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('getBuzzBalance', () => {
  it('returns the balance', async () => {
    const { api, calls } = makeClient([jsonResponse(200, { balance: 4200 })]);
    expect(await api.getBuzzBalance()).toEqual({ balance: 4200 });
    expect(calls[0].url).toContain('/api/v1/blocks/buzz');
  });
});

describe('shared storage (play-counts + popular)', () => {
  it('increments a play-count keyed by collectionId', async () => {
    const { api, calls } = makeClient([jsonResponse(200, { count: 4 })]);
    const res = await api.incrementPlayCount(101);
    expect(res.count).toBe(4);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ key: playCountKey(101) });
    expect(playCountKey(101)).toBe('playcount:101');
  });

  it('reads top-N and parses collectionId out of the key', async () => {
    const { api, calls } = makeClient([
      jsonResponse(200, { items: [{ key: 'playcount:101', count: 9 }, { key: 'playcount:102', count: 3 }] }),
    ]);
    const popular = await api.getPopular(5);
    expect(popular).toEqual([
      { collectionId: 101, count: 9 },
      { collectionId: 102, count: 3 },
    ]);
    expect(calls[0].url).toContain('prefix=playcount');
    expect(calls[0].url).toContain('limit=5');
  });
});

describe('401 re-mint + retry', () => {
  it('refreshes the token once on a 401 then retries', async () => {
    const refreshToken = vi.fn(async () => {});
    const { api, fetchImpl } = makeClient(
      [jsonResponse(401, { error: 'expired' }), jsonResponse(200, { balance: 1 })],
      { refreshToken },
    );
    const res = await api.getBuzzBalance();
    expect(res.balance).toBe(1);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces unauthorized when the retry also 401s', async () => {
    const refreshToken = vi.fn(async () => {});
    const { api } = makeClient(
      [jsonResponse(401, { error: 'expired' }), jsonResponse(401, { error: 'still expired' })],
      { refreshToken },
    );
    await expect(api.getBuzzBalance()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });
});

describe('network + parse helpers', () => {
  it('maps a thrown fetch to a network ApiError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const api = createHttpApiClient({ getToken: () => 't', fetchImpl });
    await expect(api.getBuzzBalance()).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('parseRetryAfter handles seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const future = new Date(Date.now() + 10000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(5000);
  });
});

describe('asMessageString (never lets a non-string reach .toLowerCase)', () => {
  it('passes strings through and coerces everything else safely', () => {
    expect(asMessageString('boom')).toBe('boom');
    expect(asMessageString(undefined)).toBe('');
    expect(asMessageString(null)).toBe('');
    expect(asMessageString(123)).toBe('123');
    expect(asMessageString(true)).toBe('true');
    // The exact crash input: a ZodError-shaped object.
    const zodish = { name: 'ZodError', issues: [{ path: ['sort'], message: 'Invalid enum value' }] };
    const out = asMessageString(zodish);
    expect(typeof out).toBe('string');
    expect(() => out.toLowerCase()).not.toThrow();
  });
});

describe('toApiError robustness — a NON-STRING error body must not crash the client', () => {
  it('handles `{ error: <ZodError object> }` (the sort-mismatch crash) by classifying on status', async () => {
    // This exact response is what the deployed server returns for `sort=newest`.
    const zodBody = {
      error: {
        name: 'ZodError',
        issues: [{ path: ['sort'], message: "Invalid enum value. Expected 'Newest' | 'Most Followers'" }],
      },
    };
    const { api } = makeClient([jsonResponse(400, zodBody)]);
    // Old code: `bodyMsg.toLowerCase()` threw `n.toLowerCase is not a function`.
    // New code: rejects with a well-formed ApiError, no TypeError.
    const err = await api.listCollections({ mode: 'public', sort: 'newest' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('unknown');
    expect(err.status).toBe(400);
    expect(typeof err.message).toBe('string');
  });

  it('handles a numeric error body `{ error: 123 }` without throwing', async () => {
    const { api } = makeClient([jsonResponse(400, { error: 123 })]);
    const err = await api.getBuzzBalance().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });
});
