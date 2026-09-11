// Domain types for Playable Collections. These mirror the Wave 1A block-endpoint
// response shapes documented in the plan's "API contract" section. They live in
// one place so a Wave 1A field-name adjustment is a single-file edit that the
// api-client + UI both pick up.

import type { CollectionPeriod } from './lib/period.js';

export type { CollectionPeriod };

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
   * Civitai nsfwLevel of the COVER image the server actually served for this
   * row — its NEWEST accepted item that survives the viewer's browsing ceiling
   * (`ORDER BY ci."createdAt" DESC`). Used to gate the cover thumbnail (badge +
   * blur-until-tap) on the pg13 browse surfaces.
   *
   * 🔴 NOTHING RANKS ITEMS. This said "its highest-rated representative item"
   * until 0.2.10 — a semantic the server has never implemented — and a reader
   * who believed it would expect the cover to track the collection's *worst*
   * content rather than its most recent. The level and the url are emitted
   * together from ONE image server-side (`toCoverFields`), so they cannot
   * disagree.
   *
   * Optional: absent when the list endpoint doesn't supply it — the cover then
   * falls back to the viewer's ceiling (the item-media gate + mod review remain
   * the net). Absent is NOT the same as `0`: `0` is a real level (unrated) and
   * is fail-closed, so the server omits the key entirely when there is no cover.
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
  /**
   * Which store answered this page — `'clickhouse'` for a ranked popularity
   * window, `'postgres'` otherwise. ABSENT when the request carried no `period`,
   * and absent on a host predating the param, which is why the fallback check in
   * lib/period.ts requires it to be present before warning about anything.
   *
   * Typed as a loose `string` on purpose: the server may add a store, and a
   * narrow union would turn a new value into a compile error in the consumer
   * rather than into the "unknown provenance" case the code already handles.
   */
  source?: string;
  /** The wire period the server actually applied (`'Day'`…`'AllTime'`). */
  period?: string;
  /**
   * Why the request did not get what it asked for.
   *
   * 🔴 NOT a degradation flag. It is present on a perfectly healthy
   * `period=AllTime` request (`all-time-served-from-postgres`). Read it through
   * `windowFallbackNotice`, never as a boolean.
   */
  sourceReason?: string;
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
  /**
   * Popularity window. Translated to the server's `MetricTimeframe` spelling on
   * the wire by `PERIOD_PARAM` (lib/api.ts), exactly as `sort` is.
   *
   * 🔴 Honoured ONLY for the popularity sort — the server accepts and IGNORES it
   * on `sort=newest`, reporting `period-ignored-for-non-popularity-sort`. App
   * therefore omits it entirely on the newest sort rather than sending something
   * it knows will be discarded.
   */
  period?: CollectionPeriod;
  cursor?: string;
  limit?: number;
}

/** Tip request body (mirrors POST /blocks/tip). */
export interface TipInput {
  toUserId: number;
  amount: number;
  entityType?: 'Image' | 'Collection' | 'User';
  entityId?: number;
  /**
   * A STABLE key identifying this logical tip. The server replays the first
   * terminal result for a repeated key, so a retry after a LOST response is
   * collapsed to ONE transfer instead of double-spending.
   *
   * 🔴 REUSE IT ON RETRY, ROTATE IT FOR A NEW TIP. A fresh key per attempt is
   * exactly the double-spend this field exists to prevent — and from inside the
   * iframe a lost response is indistinguishable from a rejection, which is
   * precisely where the retry button lives. Before 0.2.10 the app had no key at
   * all and had to tell the viewer "this tip may have gone through — check your
   * balance", because it genuinely could not know.
   */
  idempotencyKey?: string;
}

export interface TipResult {
  ok: boolean;
  tip?: { id?: number; amount: number; toUserId: number };
}

/**
 * The viewer's REAL daily tip allowance, straight from the server
 * (`GET /api/v1/blocks/tip-allowance`, scope `social:tip:self` — the scope the
 * app already holds to tip, so this costs no manifest change).
 *
 * 🔴 THIS REPLACES AN APP-LOCAL ESTIMATE THAT COULD NEVER WORK. Until 0.2.10 the
 * remaining allowance was derived from a `localStorage` running total, which is
 * inert in the opaque-origin sandbox (it throws, so the estimate was always the
 * full cap and tracked nothing) and in any case counted only tips made through
 * THIS app on THIS device. The picker had already stopped rendering the number
 * for that reason and recorded a host-provided store as owed upstream; this is
 * that store.
 */
export interface TipAllowance {
  /** The per-viewer daily tip ceiling, in Buzz. */
  cap: number;
  /**
   * Net Buzz reserved toward tips today. Reservation-based, so it can briefly
   * OVER-count between a reserve and its refund — which is the safe direction.
   */
  spent: number;
  /** `cap - spent`, clamped at 0 — what the viewer may still tip today. */
  remaining: number;
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
