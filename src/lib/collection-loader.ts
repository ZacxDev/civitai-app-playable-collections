// Full-collection loader for the player.
//
// Feedback #5: the block detail endpoint caps `limit` at 100 — the app used to
// request `limit=200`, which the server rejected with `400 too_big`. This loads
// the ENTIRE media set by paginating at the cap through `nextCursor`, so the
// player still plays through every item, across as many pages as needed (bounded
// by a page ceiling to protect against a pathologically large collection).

import type { ApiClient } from './api.js';
import type { CollectionPage } from '../types.js';

/** The endpoint's hard `limit` ceiling — sending more returns a 400. */
export const DETAIL_PAGE_LIMIT = 100;
/** Safety bound on the number of pages walked (100 * 50 = 5000 items). */
export const MAX_DETAIL_PAGES = 50;

/**
 * Fetch a collection's full item set for the player, paginating the detail
 * endpoint at its 100-item cap. Accumulates items across pages via `nextCursor`
 * until the cursor is exhausted or `MAX_DETAIL_PAGES` is reached. The returned
 * `nextCursor` is whatever remained after the last page (undefined when fully
 * drained; non-undefined only if the page ceiling stopped the walk early).
 */
export async function loadFullCollection(api: ApiClient, id: number): Promise<CollectionPage> {
  const first = await api.getCollection(id, { limit: DETAIL_PAGE_LIMIT });
  const items = [...first.items];
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor && pages < MAX_DETAIL_PAGES) {
    const next = await api.getCollection(id, { cursor, limit: DETAIL_PAGE_LIMIT });
    items.push(...next.items);
    cursor = next.nextCursor;
    pages += 1;
  }
  return { collection: first.collection, items, nextCursor: cursor };
}
