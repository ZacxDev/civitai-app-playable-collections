// Bounded retry for the data layer. The run-page infinite-loop bug was an
// UNBOUNDED retry over a persistently-failing fetch (same-origin -> SPA
// index.html -> JSON.parse throw -> retry forever). This caps attempts and
// NEVER retries a non-retryable failure (4xx, or a parse error whose next
// attempt would return the same non-JSON body).

import { ApiError } from './api.js';

export interface RetryConfig {
  /** Additional attempts after the first (total attempts = retries + 1). */
  retries: number;
  /** Delay between attempts (ms). 0 = no delay (used in tests). */
  delayMs: number;
}

/** Production default: at most 3 attempts, ~0.5s apart. */
export const DEFAULT_RETRY: RetryConfig = { retries: 2, delayMs: 500 };

/**
 * Only transient failures are retryable: a thrown fetch (`network`) or a 5xx.
 * Everything else — 401/403/404/429, and crucially `parse` (non-JSON 2xx) — is
 * NOT retryable: retrying returns the same result and would loop.
 */
export function isRetryableApiError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'network' || err.status >= 500);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying on retryable failures up to `retries` times, then rethrow.
 * `isRetryable` / `sleep` are injectable for deterministic tests.
 */
export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  opts: RetryConfig & {
    isRetryable?: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const isRetryable = opts.isRetryable ?? isRetryableApiError;
  const sleep = opts.sleep ?? realSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > opts.retries || !isRetryable(err)) throw err;
      if (opts.delayMs > 0) await sleep(opts.delayMs);
    }
  }
}
