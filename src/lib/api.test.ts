import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, asMessageString, createHttpApiClient, parseRetryAfter } from './api.js';

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

// 🔴 THE `setFollow` SUITE IS GONE BECAUSE THE METHOD IS (0.2.10), not because
// following stopped being tested. It moved to the host `SET_COLLECTION_FOLLOW`
// bridge. Its branch selection is pinned in lib/follow.test.tsx, and the wiring
// end-to-end in e2e.test.tsx against the SDK mock host.
// This guard keeps the HTTP path from being quietly reintroduced: re-adding it
// would need `collections:write:self`, which the manifest no longer declares, so
// it would 403 in production while passing every test written against a fake.
describe('the follow HTTP path stays deleted', () => {
  it('exposes no setFollow method and no follow route', () => {
    const { api } = makeClient([]);
    expect((api as unknown as Record<string, unknown>).setFollow).toBeUndefined();
    // Positive control: a method that IS on the client, so an empty/misspelled
    // probe cannot pass this test by accident.
    expect(typeof api.tip).toBe('function');
    expect(typeof api.getTipAllowance).toBe('function');
  });
});

describe('getTipAllowance', () => {
  it('GETs the allowance and returns the server figures verbatim', async () => {
    const { api, calls } = makeClient([jsonResponse(200, { cap: 25000, spent: 400, remaining: 24600 })]);
    const res = await api.getTipAllowance();
    // Pinned as LITERALS, never recomputed from cap - spent: the server owns
    // `remaining` (it is reservation-based and can over-count), and deriving it
    // here would make the test agree with a client that ignored the server.
    expect(res).toEqual({ cap: 25000, spent: 400, remaining: 24600 });
    expect(calls[0].url).toContain('/api/v1/blocks/tip-allowance');
    expect(calls[0].method ?? 'GET').toBe('GET');
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

  it('forwards idempotencyKey ON THE WIRE when one is supplied', async () => {
    const { api, calls } = makeClient([jsonResponse(200, { ok: true, tip: { amount: 5, toUserId: 3 } })]);
    await api.tip({ toUserId: 3, amount: 5, idempotencyKey: 'tip-abc-1' });
    // 🔴 The whole point is that the SERVER sees the key — asserting the client
    // merely accepted the field would pass with the key dropped, which is the
    // double-spend this exists to prevent.
    expect(calls[0].body).toEqual({ toUserId: 3, amount: 5, idempotencyKey: 'tip-abc-1' });
  });

  it('omits idempotencyKey entirely when none is supplied', async () => {
    const { api, calls } = makeClient([jsonResponse(200, { ok: true, tip: { amount: 5, toUserId: 3 } })]);
    await api.tip({ toUserId: 3, amount: 5 });
    expect(calls[0].body).toEqual({ toUserId: 3, amount: 5 });
    expect(Object.keys(calls[0].body as object)).not.toContain('idempotencyKey');
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

describe('401 re-mint + retry', () => {
  it('refreshes the token once on a 401 then retries', async () => {
    const refreshToken = vi.fn(async () => {});
    const { api, fetchImpl, calls } = makeClient(
      [jsonResponse(401, { error: 'expired' }), jsonResponse(200, { ok: true, tip: { amount: 7, toUserId: 3 } })],
      { refreshToken },
    );
    // 🔴 DRIVEN THROUGH `tip`, A POST WITH A BODY — deliberately, and it was a
    // GET for one commit. `request()` re-serializes `init.body` on the recursive
    // retry, so a GET-only case cannot see a regression that drops or corrupts
    // the body on re-send. `tip` is the only remaining POST on this client, and
    // it is the one carrying money.
    const res = await api.tip({ toUserId: 3, amount: 7, idempotencyKey: 'k-1' });
    expect(res.ok).toBe(true);
    // The RETRY must carry the same body — including the idempotency key, or a
    // 401-then-retry would mint a second transfer.
    expect(calls[1].body).toEqual({ toUserId: 3, amount: 7, idempotencyKey: 'k-1' });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces unauthorized when the retry also 401s', async () => {
    const refreshToken = vi.fn(async () => {});
    const { api } = makeClient(
      [jsonResponse(401, { error: 'expired' }), jsonResponse(401, { error: 'still expired' })],
      { refreshToken },
    );
    await expect(api.getTipAllowance()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });
});

describe('network + parse helpers', () => {
  it('maps a thrown fetch to a network ApiError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const api = createHttpApiClient({ getToken: () => 't', fetchImpl });
    await expect(api.getCollection(1)).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('aborts a hung fetch after timeoutMs and surfaces a retryable network error (#5)', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const api = createHttpApiClient({ getToken: () => 't', fetchImpl, timeoutMs: 10 });
    const err = await api.listCollections({ mode: 'public' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('network');
    expect((err as ApiError).message).toMatch(/timed out/i);
  });

  it('does not abort a fast fetch (timeout cleared)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [] })) as unknown as typeof fetch;
    const api = createHttpApiClient({ getToken: () => 't', fetchImpl, timeoutMs: 50 });
    await expect(api.listCollections({ mode: 'public' })).resolves.toEqual({ items: [] });
  });

  it('parseRetryAfter handles seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const future = new Date(Date.now() + 10000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(5000);
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE ABORT CEILING MUST COVER THE BODY, NOT ONLY THE HEADERS.
//
// `clearTimeout` used to live in the `finally` attached to the FETCH, i.e. it
// fired the instant the response headers arrived — leaving `await res.text()`
// on the next line completely unbounded. A server that returns 200 headers and
// then stalls the body (half-open connection, stalled proxy) therefore left the
// request pending FOREVER.
//
// That is a money defect, not a nuisance: every exit from both tip pickers is
// gated on the in-flight flag, and that flag is released by the `finally` that
// waits on this promise. A never-settling body means the viewer keeps a modal
// with no ×, dead Escape on BOTH handlers, a dead overlay and a disabled Cancel
// — recoverable only by reloading the page.
// ---------------------------------------------------------------------------
describe('the abort ceiling covers the BODY, not just the headers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * 200 headers, then a body read that never settles on its own.
   *
   * 🔴 IT DELIBERATELY IGNORES THE SIGNAL. A real fetch `Response` errors its
   * body stream when the signal aborts, so a stub that rejected on abort would
   * be testing the SPEC rather than this client — and would pass even if the
   * client dropped the ceiling entirely and merely happened to hold a signal.
   * By never settling, the ONLY thing that can end this request is the client
   * racing the read against its own still-armed abort.
   */
  function stalledBodyResponse(): Response {
    const res = new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(res, 'text', { value: () => new Promise<string>(() => {}) });
    return res;
  }

  it('rejects a stalled 2xx BODY as a `network` ApiError at the timeout bound', async () => {
    const fetchImpl = vi.fn(async () => stalledBodyResponse()) as unknown as typeof fetch;
    const api = createHttpApiClient({ getToken: () => 't', fetchImpl, timeoutMs: 15000 });

    let outcome: unknown = null;
    // Driven through `tip` on purpose: it is the call that moves money and the
    // one whose in-flight flag holds the picker's exits shut.
    void api.tip({ toUserId: 3, amount: 5, idempotencyKey: 'k-1' }).then(
      (v) => { outcome = { resolved: v }; },
      (e) => { outcome = e; },
    );

    // Still pending just BEFORE the ceiling — otherwise "it rejected" would not
    // be evidence that the ceiling is what rejected it.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(outcome).toBeNull();

    // …and rejected just after it.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome).toBeInstanceOf(ApiError);
    expect((outcome as ApiError).code).toBe('network');
    expect((outcome as ApiError).status).toBe(0);
    // Same taxonomy as a connection-phase abort, so callers keep ONE branch.
    expect((outcome as ApiError).message).toMatch(/timed out/i);
  });

  it('bounds a stalled ERROR body too, classifying on the status it already has', async () => {
    // `toApiError` reads the body as well, so the same stall on a 429 would wedge
    // just as hard. The status is already known here, so the bounded outcome is
    // the status-derived error (429 → rate_limited), not a `network` one.
    const res = new Response('nope', { status: 429, headers: { 'Retry-After': '3' } });
    Object.defineProperty(res, 'text', { value: () => new Promise<string>(() => {}) });
    const fetchImpl = vi.fn(async () => res) as unknown as typeof fetch;
    const api = createHttpApiClient({ getToken: () => 't', fetchImpl, timeoutMs: 15000 });

    let outcome: unknown = null;
    void api.getTipAllowance().then((v) => { outcome = { resolved: v }; }, (e) => { outcome = e; });

    await vi.advanceTimersByTimeAsync(14_000);
    expect(outcome).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome).toBeInstanceOf(ApiError);
    expect((outcome as ApiError).code).toBe('rate_limited');
    expect((outcome as ApiError).retryAfterMs).toBe(3000);
  });

  it('POSITIVE CONTROL: a normal response resolves, clears the timer, and never late-aborts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, tip: { amount: 5, toUserId: 3 } }),
    ) as unknown as typeof fetch;
    const api = createHttpApiClient({ getToken: () => 't', fetchImpl, timeoutMs: 15000 });

    await expect(api.tip({ toUserId: 3, amount: 5 })).resolves.toMatchObject({ ok: true });
    // The ceiling is disarmed exactly once on the success path — a client that
    // moved `clearTimeout` past the body read but forgot one exit would leave a
    // pending timer here.
    expect(vi.getTimerCount()).toBe(0);
    // …and nothing fires late.
    await vi.advanceTimersByTimeAsync(60_000);
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
    const err = await api.getCollection(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
  });
});
