// Progressive (lazy) collection loader for the player.
//
// Feedback (v0.1.5 round 2): v0.1.4 over-corrected. `loadFullCollection` EAGERLY
// walked up to `MAX_DETAIL_PAGES` (5000 items) BEFORE the player rendered, so
// opening a big collection fired up to 50 sequential requests. The player only
// needs the FIRST page to start; the rest can stream in on demand as the viewer
// advances toward the tail.
//
// So this module now exposes two thin, single-request primitives:
//   - `loadCollectionFirstPage(api, id)` — ONE request; render + play immediately.
//   - `loadMoreItems(api, id, cursor)`   — ONE request; called on demand when the
//     viewer nears the end of what's already loaded.
//
// The 100-item cap per request (the endpoint's hard `limit` ceiling) is kept, and
// the caller keeps a safety page ceiling (`MAX_DETAIL_PAGES`) so a pathologically
// large collection can never fetch unboundedly.

import type { ApiClient } from './api.js';
import type { CollectionPage, MediaItem } from '../types.js';

/** The endpoint's hard `limit` ceiling — sending more returns a 400. */
export const DETAIL_PAGE_LIMIT = 100;
/**
 * Safety ceiling on how many pages the player will ever lazily fetch
 * (100 * 50 = 5000 items). The caller stops requesting more once this many
 * pages have been loaded, so an unbounded collection can't loop forever.
 */
export const MAX_DETAIL_PAGES = 50;

/**
 * Load ONLY the first page of a collection (≤100 items) so the player can render
 * and start playing immediately. Exactly ONE request. The returned `nextCursor`
 * (when present) is handed to `loadMoreItems` on demand.
 */
export async function loadCollectionFirstPage(api: ApiClient, id: number): Promise<CollectionPage> {
  return api.getCollection(id, { limit: DETAIL_PAGE_LIMIT });
}

/** A single additional page of media items plus the cursor for the page after. */
export interface MorePage {
  items: MediaItem[];
  nextCursor?: string;
}

/**
 * Fetch ONE more page of a collection's items via the prior page's cursor.
 * Exactly one request. Dedup of an inclusive-cursor re-emit is the caller's
 * responsibility (it owns the accumulated set) — see App's append logic.
 */
export async function loadMoreItems(api: ApiClient, id: number, cursor: string): Promise<MorePage> {
  const page = await api.getCollection(id, { cursor, limit: DETAIL_PAGE_LIMIT });
  return { items: page.items, nextCursor: page.nextCursor };
}
