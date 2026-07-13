import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './api.js';
import { DEFAULT_RETRY, isRetryableApiError, withBoundedRetry } from './retry.js';

const noSleep = { delayMs: 0, sleep: vi.fn(async () => {}) };

describe('isRetryableApiError', () => {
  it('retries transient failures (network, 5xx) only', () => {
    expect(isRetryableApiError(new ApiError('network', 0, 'offline'))).toBe(true);
    expect(isRetryableApiError(new ApiError('unknown', 500, 'boom'))).toBe(true);
    expect(isRetryableApiError(new ApiError('unknown', 503, 'down'))).toBe(true);
  });

  it('does NOT retry 4xx, rate-limit, or parse (non-JSON 2xx) errors', () => {
    expect(isRetryableApiError(new ApiError('forbidden', 403, 'no'))).toBe(false);
    expect(isRetryableApiError(new ApiError('not_found', 404, 'gone'))).toBe(false);
    expect(isRetryableApiError(new ApiError('rate_limited', 429, 'slow'))).toBe(false);
    expect(isRetryableApiError(new ApiError('parse', 200, 'html'))).toBe(false);
    expect(isRetryableApiError(new ApiError('unauthorized', 401, 'expired'))).toBe(false);
    expect(isRetryableApiError(new Error('plain'))).toBe(false);
  });
});

describe('withBoundedRetry', () => {
  it('returns the value on first success (1 attempt, no sleep)', async () => {
    const fn = vi.fn(async () => 'ok');
    const res = await withBoundedRetry(fn, { retries: 2, ...noSleep });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(noSleep.sleep).not.toHaveBeenCalled();
  });

  it('caps attempts at retries+1 for a persistent retryable error, then rethrows', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new ApiError('unknown', 500, 'boom');
    });
    await expect(withBoundedRetry(fn, { retries: 2, delayMs: 10, sleep })).rejects.toMatchObject({
      status: 500,
    });
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries — BOUNDED, no loop
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-retryable error (1 attempt, immediate)', async () => {
    const fn = vi.fn(async () => {
      throw new ApiError('parse', 200, 'got HTML');
    });
    await expect(withBoundedRetry(fn, { retries: 5, ...noSleep })).rejects.toMatchObject({
      code: 'parse',
    });
    expect(fn).toHaveBeenCalledTimes(1); // the loop-killer: HTML/parse never retries
  });

  it('succeeds on a later attempt within the cap', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 2) throw new ApiError('network', 0, 'blip');
      return 'recovered';
    });
    const res = await withBoundedRetry(fn, { retries: 3, ...noSleep });
    expect(res).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('DEFAULT_RETRY is bounded (small)', () => {
    expect(DEFAULT_RETRY.retries).toBeLessThanOrEqual(3);
    expect(DEFAULT_RETRY.retries).toBeGreaterThanOrEqual(1);
  });
});
