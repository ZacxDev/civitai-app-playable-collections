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
  CollectionPage,
  CollectionSummary,
  ListCollectionsParams,
  Page,
  TipAllowance,
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
  | 'parse' // 2xx body wasn't JSON (e.g. same-origin SPA index.html) — NON-retryable
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
  /** POST /blocks/tip — scope social:tip:self */
  tip(input: TipInput): Promise<TipResult>;
  /**
   * GET /blocks/tip-allowance — scope social:tip:self (already held for `tip`).
   * The viewer's REAL remaining daily allowance, replacing the app-local
   * localStorage estimate that was inert in the sandbox. See `TipAllowance`.
   */
  getTipAllowance(): Promise<TipAllowance>;
}
// 🔴 `setFollow` IS DELIBERATELY GONE, NOT MISSING (0.2.10). Following moved to
// the host-mediated `SET_COLLECTION_FOLLOW` bridge (`FollowButton` /
// `useCollectionFollow` from @civitai/blocks-react), which needs NO block scope
// and NO token: the host calls the session-authed procedure and self-binds the
// viewer server-side. That let the manifest drop `collections:write:self`.
// Re-adding an HTTP follow here would reintroduce a scope the app no longer
// declares, so the call would 403 — and it would skip the host's per-action
// consent confirm, which is the only consent this path has ever had.
// NOTE: the viewer's Buzz balance and the cross-user "popular" play-counts are
// NOT part of this HTTP client. They go through the host-mediated postMessage
// bridges instead: `useBuzzBalance()` (scope-free GET_BUZZ_BALANCE) and
// `useSharedStorage()` (apps:storage:shared:*). See ./popular.ts + App.tsx.
// The retired `/api/v1/blocks/buzz` (civitai #3144) and the never-real guessed
// `/api/v1/blocks/shared-storage/{increment,top}` routes were removed here.

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
  /**
   * Per-request ceiling (ms). A single hung fetch is aborted after this and
   * surfaces as a retryable `network` error, so a stalled request can't wedge a
   * loader forever (the bounded retry still caps total attempts). Default 15s;
   * 0 disables the timeout.
   */
  timeoutMs?: number;
}

/** Default per-request abort ceiling. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Endpoint paths. Kept in one map so Wave 1A path changes are a one-line edit.
// ---------------------------------------------------------------------------
const PATHS = {
  collections: '/api/v1/blocks/collections',
  collection: (id: number) => `/api/v1/blocks/collections/${id}`,
  tip: '/api/v1/blocks/tip',
  // Same origin + bearer + scope as `tip`; the path upstream's `useTipAllowance`
  // uses. Routed through this client rather than that hook on purpose — the hook
  // raw-`fetch`es, which would bypass the injected fake every test and the dev
  // harness depend on, and would lose this client's ApiError taxonomy
  // (`insufficient_balance` / `rate_limited` + Retry-After / `network`) that the
  // tip UX branches on.
  tipAllowance: '/api/v1/blocks/tip-allowance',
} as const;

/**
 * Translate the app's friendly UI sort values to the values the DEPLOYED server
 * accepts (its `CollectionSort` enum). Only the HTTP WIRE value is translated —
 * the app/UI + the fake api keep speaking `'newest'`/`'popular'`.
 *
 * 🔴 The server's enum is exactly `'Newest'` | `'Most Followers'`; sending the
 * lowercase `newest`/`popular` (or a nonexistent `name`) fails its Zod gate and
 * returns a ZodError body — the crash this map + the hardened `toApiError` fix.
 */
export const SORT_PARAM: Record<'newest' | 'popular', string> = {
  newest: 'Newest',
  popular: 'Most Followers',
};

export function createHttpApiClient(opts: HttpApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl ?? '';
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

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

    // Per-request abort ceiling: a hung request is aborted after `timeoutMs` so a
    // single stalled request can't wedge a loader indefinitely.
    //
    // 🔴 THE CEILING SPANS THE WHOLE IN-FLIGHT WINDOW — HEADERS *AND* BODY.
    // `clearTimeout` used to sit in the `finally` attached to the fetch below,
    // which disarms it the instant the response headers arrive; the body read
    // that follows was then completely unbounded, so a server answering 200 and
    // then stalling the body (half-open connection, stalled proxy) left this
    // promise pending FOREVER. That is a money defect: every exit from both tip
    // pickers is gated on an in-flight flag released only when this settles, so
    // a stalled body leaves the viewer in a modal with no ×, dead Escape on both
    // handlers, a dead overlay and a disabled Cancel — page reload or nothing.
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let disarmed = false;
    /**
   * Disarm the ceiling.
   *
   * ⚠️ THE `disarmed` FLAG IS DEFENSIVE, NOT LOAD-BEARING, and saying so is the
   * point: `clearTimeout` is already idempotent, so removing the flag changes no
   * observable behaviour and its mutant SURVIVES the suite. It is kept because a
   * future edit could give this a non-idempotent body, and it is labelled so
   * nobody cites it as a tested guarantee. An earlier comment here claimed "every
   * exit clears exactly once" as though something checked that; nothing does.
   */
    const disarm = () => {
      if (timer && !disarmed) {
        disarmed = true;
        clearTimeout(timer);
      }
    };

    try {
      let res: Response;
      try {
        res = await doFetch(baseUrl ? url.toString() : path + url.search, {
          method: init.method ?? 'GET',
          headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        // Our timeout fired → a retryable network error; otherwise the raw failure.
        if (controller.signal.aborted) {
          throw new ApiError('network', 0, 'The request timed out.');
        }
        throw new ApiError('network', 0, err instanceof Error ? err.message : 'Network error');
      }

      if (res.ok) {
        // 204 / empty body tolerance.
        let text: string;
        try {
          text = await readTextBounded(res, controller.signal);
        } catch (err) {
          // An abort raised out of the BODY read is the same failure as one raised
          // out of the connection — one taxonomy, so callers keep one branch.
          if (controller.signal.aborted) {
            throw new ApiError('network', 0, 'The request timed out.');
          }
          throw new ApiError('network', 0, err instanceof Error ? err.message : 'Network error');
        }
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          // A 2xx whose body isn't JSON — the classic "block fetched its own
          // subdomain and got the SPA index.html" failure. NON-retryable: retrying
          // the same URL returns the same HTML, so surface it as an error state
          // instead of looping.
          throw new ApiError('parse', res.status, 'The API returned an unexpected (non-JSON) response.');
        }
      }

      // 401 → try one token re-mint + retry (expired-token path).
      if (res.status === 401 && !_isRetry && opts.refreshToken) {
        // Disarm before handing off: the retry arms its OWN ceiling.
        //
        // ⚠️ DEFENSIVE, AND ITS MUTANT SURVIVES — do not read this as a tested
        // guard. Once the 401 response is in hand nothing awaits this
        // controller, so aborting it here is unobservable. The previous comment
        // said `refreshToken` is "a wait this one must not straddle", implying a
        // hazard this line prevents; it does not. `refreshToken` is separately
        // bounded upstream (`IframeTransport.sendRequest`, 30s), so the worst
        // case is 15 + 30 + 15s, and that bound comes from the SDK, not here.
        disarm();
        await opts.refreshToken().catch(() => {});
        return await request<T>(path, init, true);
      }

      // `toApiError` reads the body too, so the same stall would wedge here.
      // The signal keeps that read bounded; the status is already known, so a
      // stalled error body still classifies on status rather than hanging.
      throw await toApiError(res, controller.signal);
    } finally {
      disarm();
    }
  }

  return {
    async listCollections(params) {
      return request<Page<CollectionSummary>>(PATHS.collections, {
        query: {
          mode: params.mode,
          query: params.query,
          // Translate the friendly UI sort to the server's accepted enum value.
          sort: params.sort ? SORT_PARAM[params.sort] : undefined,
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

    async tip(input) {
      return request<TipResult>(PATHS.tip, { method: 'POST', body: input });
    },

    async getTipAllowance() {
      return request<TipAllowance>(PATHS.tipAllowance, {});
    },
  };
}

/**
 * Read a response body under the request's abort ceiling.
 *
 * 🔴 THE RACE IS EXPLICIT, NOT INCIDENTAL. Per the fetch spec a real `Response`
 * errors its body stream when the request's signal aborts, so a bare
 * `await res.text()` would *usually* be bounded — but "usually" is doing all the
 * work in that sentence, and this is the call that decides whether a viewer can
 * ever close the tip modal. Racing the read against the signal makes the bound a
 * property of THIS client instead of a property of whatever `fetch`
 * implementation the host page happens to ship.
 *
 * The losing `res.text()` is left dangling deliberately: the connection is being
 * torn down by the same abort, and there is nothing useful to do with a body
 * that arrives after we have already reported a timeout. It is HANDLED, not
 * merely dropped — `.then(resolve, reject)` attaches a rejection handler, so a
 * later rejection cannot surface as an unhandled rejection.
 *
 * ⚠️ The `signal.aborted` early return is DEFENSIVE and its mutant SURVIVES —
 * but NOT for the reason this comment gave until an audit measured it. It said
 * "the abort listener below covers the already-aborted case on its own", and
 * that is FALSE: `addEventListener('abort', …)` on a signal that has ALREADY
 * aborted never fires, because the event dispatches once, at abort time.
 * Measured on Node v26, and measured again by deleting the early return — the
 * promise then RESOLVES WITH THE BODY TEXT instead of rejecting.
 *
 * 🔴 So deleting this line is not neutral, and the old comment invited exactly
 * that: a maintainer trusting it would, in any environment where a mocked or
 * non-spec `fetchImpl` can resolve after an abort, get a silently successful
 * JSON parse of a body read AFTER a timeout was already reported.
 *
 * The line's real status is STRONGER than "defensive": it is UNREACHABLE in
 * production. Nothing yields between `res = await doFetch(...)` resolving and
 * the synchronous call to this function — timers are macrotasks, and only
 * microtasks run in between — and a real `fetch` rejects on abort rather than
 * resolving. That is why the mutant survives: the branch cannot be entered, not
 * because something else catches it.
 */
function readTextBounded(res: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    res.text().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// ---------------------------------------------------------------------------
// Status + body -> ApiError mapping. Centralized so every endpoint reports the
// same UI-actionable codes.
// ---------------------------------------------------------------------------
async function toApiError(res: Response, signal?: AbortSignal): Promise<ApiError> {
  let bodyText = '';
  let bodyMsg = '';
  try {
    // Bounded by the request's ceiling — an error response whose body stalls
    // must not wedge the caller either. The read failing (including by abort) is
    // caught below and the error is classified on its status alone, which is
    // strictly more useful here than reporting a `network` failure for a
    // response whose status we already have.
    bodyText = signal ? await readTextBounded(res, signal) : await res.text();
    if (bodyText) {
      const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown; code?: unknown };
      // 🔴 The server can return a NON-STRING error (e.g. `{ error: <ZodError
      // object> }` on a sort/validation failure). `bodyMsg` MUST end up a string
      // — coercing here is what stops `.toLowerCase()` from throwing
      // `n.toLowerCase is not a function` and crashing the run page.
      bodyMsg = asMessageString(parsed.error ?? parsed.message);
      // Explicit machine code wins if the server sends one.
      if (parsed.code === 'INSUFFICIENT_BALANCE' || parsed.code === 'insufficient_balance') {
        return new ApiError('insufficient_balance', res.status, bodyMsg || 'Not enough Buzz.');
      }
    }
  } catch {
    bodyMsg = typeof bodyText === 'string' ? bodyText : '';
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

/**
 * Coerce an unknown error-body value into a safe, non-empty-or-empty STRING.
 * Strings pass through; objects/arrays are JSON-stringified (best-effort);
 * numbers/booleans are String()'d; null/undefined -> ''. Never throws — the
 * whole point is that `.toLowerCase()` downstream can never see a non-string.
 */
export function asMessageString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
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
