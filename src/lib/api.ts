// The single, swappable network boundary for Playable Collections.
//
// EVERY call to the civitai App Blocks HTTP API goes through the `ApiClient`
// interface. Production wires `createHttpApiClient()` (block-token Bearer auth
// against `/api/v1/blocks/*`); tests + the dev harness inject an in-memory fake
// (see ../fake-api.ts) implementing the SAME interface. Keeping all network
// shape here means a Wave 1A contract adjustment (field renames, endpoint
// paths) is bounded to this file.
//
// Contract source: plan-app-playable-collections-2026-07-13.md §"API contract".
// All block endpoints are `verifyBlockToken` + per-op scope + revocation-gated,
// exactly like the existing /api/v1/blocks/* routes (images.ts / me.ts):
//   - anon / expired token        -> 401
//   - missing scope / self-tip    -> 403
//   - rate limited                -> 429 (+ Retry-After)
//   - insufficient Buzz on a tip  -> 4xx with an insufficient-balance error code
//   - deleted / hidden resource   -> 404

import type {
  BuzzBalance,
  CollectionPage,
  CollectionSummary,
  ListCollectionsParams,
  Page,
  PopularEntry,
  TipInput,
  TipResult,
} from '../types.js';

/** Coarse, UI-actionable failure kinds mapped from HTTP status + body. */
export type ApiErrorCode =
  | 'unauthorized' // 401 — token invalid/expired/anon; UI should re-mint or show sign-in
  | 'forbidden' // 403 — missing scope, banned, or a rejected self-tip
  | 'rate_limited' // 429 — back off; `retryAfterMs` is populated when the host sends Retry-After
  | 'insufficient_balance' // tip rejected for not enough Buzz
  | 'not_found' // 404 — collection/media gone
  | 'network' // fetch threw (offline / DNS / CORS)
  | 'unknown'; // anything else

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Populated for `rate_limited` when the host returned a Retry-After header. */
  readonly retryAfterMs?: number;

  constructor(code: ApiErrorCode, status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The interface both the real HTTP client and the test/dev fake implement. */
export interface ApiClient {
  /** GET /blocks/collections?mode&query&sort&cursor&limit — scope collections:read:self */
  listCollections(params: ListCollectionsParams): Promise<Page<CollectionSummary>>;
  /** GET /blocks/collections/[id]?cursor&limit — scope collections:read:self */
  getCollection(id: number, opts?: { cursor?: string; limit?: number }): Promise<CollectionPage>;
  /** POST /blocks/collections/[id]/follow — scope collections:write:self */
  setFollow(id: number, follow: boolean): Promise<{ followed: boolean }>;
  /** POST /blocks/tip — scope social:tip:self */
  tip(input: TipInput): Promise<TipResult>;
  /** GET the viewer's spendable Buzz balance — scope buzz:read:self */
  getBuzzBalance(): Promise<BuzzBalance>;
  /** Increment the shared play-count for a collection — scope apps:storage:shared:write */
  incrementPlayCount(collectionId: number): Promise<{ count: number }>;
  /** Read the top-N most-played collections — scope apps:storage:shared:read */
  getPopular(limit: number): Promise<PopularEntry[]>;
}

export interface HttpApiClientOptions {
  /** API origin. Empty string = same origin as the host page (default). */
  baseUrl?: string;
  /** Returns the current block JWT `raw` string for the Authorization header. */
  getToken: () => string | undefined;
  /**
   * Force an immediate token re-mint (from `useBlockToken().refresh`). Called
   * once on a 401 before a single retry — the token may simply have expired.
   */
  refreshToken?: () => Promise<void>;
  /** Injectable fetch (tests pass a stub; prod uses global fetch). */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Endpoint paths. Kept in one map so Wave 1A path changes are a one-line edit.
// ---------------------------------------------------------------------------
const PATHS = {
  collections: '/api/v1/blocks/collections',
  collection: (id: number) => `/api/v1/blocks/collections/${id}`,
  follow: (id: number) => `/api/v1/blocks/collections/${id}/follow`,
  tip: '/api/v1/blocks/tip',
  // NOTE(wave1a): the plan lists buzz:read:self for the balance readout but does
  // not pin an endpoint. `/api/v1/blocks/me` intentionally omits balance (see
  // me.ts), so a dedicated buzz route is required. Reconcile the exact path.
  buzz: '/api/v1/blocks/buzz',
  // NOTE(wave1a): shared play-counts "reuse the EXISTING apps:storage:shared:*
  // endpoints (apps-shared.router)". That router's concrete REST shape is not in
  // the plan's contract; these two paths are our best-guess surface. Reconcile.
  sharedIncrement: '/api/v1/blocks/shared-storage/increment',
  sharedTop: '/api/v1/blocks/shared-storage/top',
} as const;

/** Shared-storage key convention for a collection's play-count. */
export function playCountKey(collectionId: number): string {
  return `playcount:${collectionId}`;
}

const PLAYCOUNT_PREFIX = 'playcount:';

export function createHttpApiClient(opts: HttpApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl ?? '';
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  async function request<T>(
    path: string,
    init: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown },
    _isRetry = false,
  ): Promise<T> {
    const url = new URL(baseUrl + path, baseUrl || 'http://localhost');
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const token = opts.getToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await doFetch(baseUrl ? url.toString() : path + url.search, {
        method: init.method ?? 'GET',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      throw new ApiError('network', 0, err instanceof Error ? err.message : 'Network error');
    }

    if (res.ok) {
      // 204 / empty body tolerance.
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }

    // 401 → try one token re-mint + retry (expired-token path).
    if (res.status === 401 && !_isRetry && opts.refreshToken) {
      await opts.refreshToken().catch(() => {});
      return request<T>(path, init, true);
    }

    throw await toApiError(res);
  }

  return {
    async listCollections(params) {
      return request<Page<CollectionSummary>>(PATHS.collections, {
        query: {
          mode: params.mode,
          query: params.query,
          sort: params.sort,
          cursor: params.cursor,
          limit: params.limit,
        },
      });
    },

    async getCollection(id, opts2) {
      return request<CollectionPage>(PATHS.collection(id), {
        query: { cursor: opts2?.cursor, limit: opts2?.limit },
      });
    },

    async setFollow(id, follow) {
      return request<{ followed: boolean }>(PATHS.follow(id), {
        method: 'POST',
        body: { follow },
      });
    },

    async tip(input) {
      return request<TipResult>(PATHS.tip, { method: 'POST', body: input });
    },

    async getBuzzBalance() {
      return request<BuzzBalance>(PATHS.buzz, {});
    },

    async incrementPlayCount(collectionId) {
      return request<{ count: number }>(PATHS.sharedIncrement, {
        method: 'POST',
        body: { key: playCountKey(collectionId) },
      });
    },

    async getPopular(limit) {
      const res = await request<{ items: Array<{ key: string; count: number }> }>(PATHS.sharedTop, {
        query: { prefix: PLAYCOUNT_PREFIX, limit },
      });
      return res.items
        .map((row) => ({
          collectionId: Number(row.key.slice(PLAYCOUNT_PREFIX.length)),
          count: row.count,
        }))
        .filter((e) => Number.isFinite(e.collectionId));
    },
  };
}

// ---------------------------------------------------------------------------
// Status + body -> ApiError mapping. Centralized so every endpoint reports the
// same UI-actionable codes.
// ---------------------------------------------------------------------------
async function toApiError(res: Response): Promise<ApiError> {
  let bodyText = '';
  let bodyMsg = '';
  try {
    bodyText = await res.text();
    if (bodyText) {
      const parsed = JSON.parse(bodyText) as { error?: string; message?: string; code?: string };
      bodyMsg = parsed.error ?? parsed.message ?? '';
      // Explicit machine code wins if the server sends one.
      if (parsed.code === 'INSUFFICIENT_BALANCE' || parsed.code === 'insufficient_balance') {
        return new ApiError('insufficient_balance', res.status, bodyMsg || 'Not enough Buzz.');
      }
    }
  } catch {
    bodyMsg = bodyText;
  }

  const lower = bodyMsg.toLowerCase();
  // Insufficient balance can surface as a 400/402/403 with a telltale message.
  if (
    lower.includes('insufficient') ||
    lower.includes('not enough buzz') ||
    lower.includes('balance')
  ) {
    return new ApiError('insufficient_balance', res.status, bodyMsg || 'Not enough Buzz.');
  }

  switch (res.status) {
    case 401:
      return new ApiError('unauthorized', 401, bodyMsg || 'Your session expired. Please sign in again.');
    case 403:
      return new ApiError('forbidden', 403, bodyMsg || 'You do not have permission to do that.');
    case 404:
      return new ApiError('not_found', 404, bodyMsg || 'That collection could not be found.');
    case 429: {
      const retryAfter = res.headers.get('Retry-After');
      const retryAfterMs = parseRetryAfter(retryAfter);
      return new ApiError('rate_limited', 429, bodyMsg || 'Too many requests. Please slow down.', retryAfterMs);
    }
    default:
      return new ApiError('unknown', res.status, bodyMsg || `Request failed (${res.status}).`);
  }
}

/** Retry-After is either delta-seconds or an HTTP-date. Returns ms, or undefined. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const asInt = Number(value);
  if (Number.isFinite(asInt)) return Math.max(0, asInt * 1000);
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}
