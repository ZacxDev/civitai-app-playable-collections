import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './api.js';
import type { CollectionDetail, CollectionPage, MediaItem } from '../types.js';
import { DETAIL_PAGE_LIMIT, MAX_DETAIL_PAGES, loadFullCollection } from './collection-loader.js';

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

describe('loadFullCollection', () => {
  it('requests the detail endpoint at the 100 cap, NEVER above it', async () => {
    const { api, calls } = stub([{ collection: detail, items: [item(1)], nextCursor: undefined }]);
    await loadFullCollection(api, 7);
    expect(calls[0].opts?.limit).toBe(DETAIL_PAGE_LIMIT);
    expect(DETAIL_PAGE_LIMIT).toBeLessThanOrEqual(100);
    for (const call of calls) expect(call.opts?.limit).toBeLessThanOrEqual(100);
  });

  it('single page (no nextCursor) → one request, items returned as-is', async () => {
    const { api, calls } = stub([
      { collection: detail, items: [item(1), item(2)], nextCursor: undefined },
    ]);
    const page = await loadFullCollection(api, 7);
    expect(calls).toHaveLength(1);
    expect(page.items.map((i) => i.mediaId)).toEqual([1, 2]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('paginates through nextCursor and accumulates the full set across pages', async () => {
    const { api, calls } = stub([
      { collection: detail, items: [item(1), item(2)], nextCursor: 'c1' },
      { collection: detail, items: [item(3), item(4)], nextCursor: 'c2' },
      { collection: detail, items: [item(5)], nextCursor: undefined },
    ]);
    const page = await loadFullCollection(api, 7);
    expect(calls).toHaveLength(3);
    // Subsequent pages forward the prior nextCursor.
    expect(calls[1].opts?.cursor).toBe('c1');
    expect(calls[2].opts?.cursor).toBe('c2');
    expect(page.items.map((i) => i.mediaId)).toEqual([1, 2, 3, 4, 5]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('stops at MAX_DETAIL_PAGES even if the server keeps returning a cursor', async () => {
    // Every page returns a fresh cursor → the walk must be bounded by the ceiling.
    const { api, calls } = stub([{ collection: detail, items: [item(1)], nextCursor: 'always' }]);
    const page = await loadFullCollection(api, 7);
    expect(calls).toHaveLength(MAX_DETAIL_PAGES);
    // Cursor still present (walk stopped early), NOT an infinite loop.
    expect(page.nextCursor).toBe('always');
  });
});
