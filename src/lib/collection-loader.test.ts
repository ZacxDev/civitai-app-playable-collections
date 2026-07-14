import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './api.js';
import type { CollectionDetail, CollectionPage, MediaItem } from '../types.js';
import {
  DETAIL_PAGE_LIMIT,
  MAX_DETAIL_PAGES,
  loadCollectionFirstPage,
  loadMoreItems,
} from './collection-loader.js';

const detail: CollectionDetail = {
  id: 7,
  name: 'C',
  description: null,
  curator: { userId: 1, username: 'a' },
  isPublic: true,
  followed: false,
};

function item(mediaId: number): MediaItem {
  return {
    mediaId,
    type: 'image',
    url: `u/${mediaId}`,
    width: 10,
    height: 10,
    creator: { userId: 1, username: 'a' },
    nsfwLevel: 1,
  };
}

/** A getCollection stub that serves fixed pages and records the args it saw. */
function stub(pages: CollectionPage[]) {
  const calls: Array<{ id: number; opts?: { cursor?: string; limit?: number } }> = [];
  let i = 0;
  const api = {
    getCollection: vi.fn(async (id: number, opts?: { cursor?: string; limit?: number }) => {
      calls.push({ id, opts });
      return pages[Math.min(i++, pages.length - 1)];
    }),
  } as unknown as ApiClient;
  return { api, calls };
}

describe('loadCollectionFirstPage (lazy open — one fetch, not fifty)', () => {
  it('opens a collection with EXACTLY ONE request, at the 100 cap', async () => {
    const { api, calls } = stub([
      { collection: detail, items: [item(1), item(2)], nextCursor: 'c1' },
      { collection: detail, items: [item(3)], nextCursor: undefined },
    ]);
    const page = await loadCollectionFirstPage(api, 7);
    // ONE fetch on open even though a nextCursor is present — the rest is lazy.
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.limit).toBe(DETAIL_PAGE_LIMIT);
    expect(DETAIL_PAGE_LIMIT).toBeLessThanOrEqual(100);
    expect(page.items.map((i) => i.mediaId)).toEqual([1, 2]);
    // The cursor for the NEXT page is surfaced for on-demand loading.
    expect(page.nextCursor).toBe('c1');
  });

  it('a single-page collection surfaces no cursor (nothing more to load)', async () => {
    const { api, calls } = stub([{ collection: detail, items: [item(1)], nextCursor: undefined }]);
    const page = await loadCollectionFirstPage(api, 7);
    expect(calls).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('loadMoreItems (on-demand next page)', () => {
  it('fetches ONE page forwarding the cursor, returning items + the next cursor', async () => {
    const { api, calls } = stub([{ collection: detail, items: [item(3), item(4)], nextCursor: 'c2' }]);
    const more = await loadMoreItems(api, 7, 'c1');
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.cursor).toBe('c1');
    expect(calls[0].opts?.limit).toBe(DETAIL_PAGE_LIMIT);
    expect(more.items.map((i) => i.mediaId)).toEqual([3, 4]);
    expect(more.nextCursor).toBe('c2');
  });

  it('never requests above the 100 cap', async () => {
    const { api, calls } = stub([{ collection: detail, items: [item(9)], nextCursor: undefined }]);
    await loadMoreItems(api, 7, 'cursor');
    for (const call of calls) expect(call.opts?.limit).toBeLessThanOrEqual(100);
  });

  it('MAX_DETAIL_PAGES is a sane safety ceiling', () => {
    expect(MAX_DETAIL_PAGES).toBeGreaterThan(1);
    expect(MAX_DETAIL_PAGES).toBeLessThanOrEqual(100);
  });
});
