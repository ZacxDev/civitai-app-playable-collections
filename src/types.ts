// Domain types for Playable Collections. These mirror the Wave 1A block-endpoint
// response shapes documented in the plan's "API contract" section. They live in
// one place so a Wave 1A field-name adjustment is a single-file edit that the
// api-client + UI both pick up.

/** A minimal user reference (creator of a media item, or a collection curator). */
export interface UserRef {
  userId: number;
  username: string | null;
}

/** A collection as it appears in a discover/mine grid (list endpoint). */
export interface CollectionSummary {
  id: number;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  itemCount: number;
  curator: UserRef;
  isPublic: boolean;
  /** Whether the viewer follows/bookmarks this collection. */
  followed: boolean;
  /**
   * Civitai nsfwLevel of the COVER (its highest-rated representative item). Used
   * to gate the cover thumbnail (badge + blur-until-tap) on the pg13 browse
   * surfaces. Optional: absent when the list endpoint doesn't supply it — the
   * cover then renders ungated (the item-media gate + mod review remain the net).
   */
  coverNsfwLevel?: number;
}

/** The collection header returned alongside a page of items (detail endpoint). */
export interface CollectionDetail {
  id: number;
  name: string;
  description: string | null;
  curator: UserRef;
  isPublic: boolean;
  followed: boolean;
}

/** One playable media item inside a collection. */
export interface MediaItem {
  mediaId: number;
  type: 'image' | 'video';
  url: string;
  width: number;
  height: number;
  creator: UserRef;
  /** Civitai nsfwLevel bitmask value; UI uses it only for a maturity badge. */
  nsfwLevel: number;
}

/** A cursor-paginated page of anything. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** The collection-detail endpoint response (header + first page of items). */
export interface CollectionPage {
  collection: CollectionDetail;
  items: MediaItem[];
  nextCursor?: string;
}

/**
 * Sort options for the discover tab. Maps to the server's `CollectionSort` enum
 * on the wire (see `SORT_PARAM` in lib/api.ts): `newest`→`Newest`,
 * `popular`→`Most Followers`. There is NO name-sort on the service.
 */
export type CollectionSort = 'newest' | 'popular';

/** List query parameters. */
export interface ListCollectionsParams {
  mode: 'public' | 'mine';
  query?: string;
  sort?: CollectionSort;
  cursor?: string;
  limit?: number;
}

/** Tip request body (mirrors POST /blocks/tip). */
export interface TipInput {
  toUserId: number;
  amount: number;
  entityType?: 'Image' | 'Collection' | 'User';
  entityId?: number;
}

export interface TipResult {
  ok: boolean;
  tip?: { id?: number; amount: number; toUserId: number };
}

/**
 * One entry of the cross-user "popular collections" rail. Derived client-side
 * from the App Blocks SHARED store (see lib/popular.ts) — `count` is the entry's
 * distinct-viewer vote total, NOT a raw play counter.
 */
export interface PopularEntry {
  collectionId: number;
  count: number;
}
