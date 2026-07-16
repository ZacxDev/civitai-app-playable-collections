// Cross-user "popular collections" popularity, backed by App Blocks SHARED
// storage (`useSharedStorage()` — the apps:storage:shared:* postMessage bridge).
//
// This REPLACES the two guessed REST endpoints the block used to call:
//   POST /api/v1/blocks/shared-storage/increment   (never a real route)
//   GET  /api/v1/blocks/shared-storage/top         (never a real route)
//
// The real SHARED store is an app-scoped, community-VOTABLE list of entries
// (`{ title, body?, data? }` records with a host-minted `key` and a live vote
// `count`, one idempotent vote per viewer). We map "how popular is a collection"
// onto that model:
//   • ONE shared entry per collection, tagged with `data.collectionId`.
//   • "playing" a collection = an (idempotent) up-VOTE on its entry — so a
//     collection's popularity is its count of DISTINCT viewers who've played it.
//     This is a stronger cross-user signal than the old raw increment (which
//     couldn't dedupe per viewer). Replaying the same collection is a no-op.
//   • the "popular" rail = the entries sorted by vote count, top-N.
//
// The functions take only the SHARED-store slice they use so they're pure +
// unit-testable with a fake store (see popular.test.ts).

import type { SharedAppendValue, SharedListItem, UseSharedStorage } from '@civitai/blocks-react';

import type { PopularEntry } from '../types.js';

/** The SHARED-store surface the popularity helpers need (subset of the hook). */
export type SharedStore = Pick<UseSharedStorage, 'list' | 'append' | 'vote'>;

/** Read-only slice — `readPopular` only lists. */
export type SharedReadStore = Pick<UseSharedStorage, 'list'>;

/**
 * How many SHARED entries to pull when ranking. The store's `list()` is
 * newest-first (not count-sorted), so we fetch a bounded page and rank
 * client-side — fine for a nice-to-have discovery rail with a modest entry set.
 */
const LIST_LIMIT = 200;

/** Host title cap is generous; keep our synthesized title short + safe. */
const MAX_TITLE = 120;

/** Pull the app-owned `collectionId` back out of an entry's opaque `data` blob. */
export function entryCollectionId(value: SharedAppendValue): number | null {
  const data = value?.data;
  if (data && typeof data === 'object' && 'collectionId' in data) {
    const id = (data as { collectionId?: unknown }).collectionId;
    if (typeof id === 'number' && Number.isFinite(id)) return id;
  }
  return null;
}

/** Find this app's SHARED entry for a given collection, if one exists. */
async function findEntry(
  shared: SharedReadStore,
  collectionId: number,
): Promise<SharedListItem | undefined> {
  const { items } = await shared.list({ limit: LIST_LIMIT });
  return items.find((it) => entryCollectionId(it.value) === collectionId);
}

/**
 * Record that the viewer played `collection`: up-vote its SHARED entry, creating
 * the entry (then self-voting so it starts at count ≥ 1) if it doesn't exist yet.
 * Idempotent per viewer — replaying doesn't inflate the count. Requires the
 * `apps:storage:shared:write` scope (append/vote). Rejects with the host error
 * string on a hard failure; callers treat popularity as best-effort.
 */
export async function recordPlay(
  shared: SharedStore,
  collection: { id: number; name: string },
): Promise<void> {
  const existing = await findEntry(shared, collection.id);
  if (existing) {
    await shared.vote(existing.key);
    return;
  }
  const title = collection.name.trim().slice(0, MAX_TITLE) || `Collection ${collection.id}`;
  const { key } = await shared.append({ title, data: { collectionId: collection.id } });
  // Count the author's own play so a freshly-seeded collection ranks immediately.
  await shared.vote(key);
}

/**
 * The top-N most-played collections by distinct-viewer vote count (desc). Reads
 * a bounded page of SHARED entries and ranks client-side. Requires the
 * `apps:storage:shared:read` scope; anonymous viewers can still read.
 */
export async function readPopular(shared: SharedReadStore, limit: number): Promise<PopularEntry[]> {
  const { items } = await shared.list({ limit: LIST_LIMIT });
  return items
    .map((it) => ({ collectionId: entryCollectionId(it.value), count: it.count }))
    .filter((e): e is PopularEntry => e.collectionId != null && e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * The viewer's single spendable Buzz figure for the header pill + the tip
 * modal's soft ceiling. `useBuzzBalance()` returns per-pool balances
 * (`{ blue, green, yellow }`); we sum them for a "your Buzz" total. Over- rather
 * than under-reporting is the safe direction: the soft client check never falsely
 * blocks a valid tip, and the SERVER stays authoritative (a genuinely
 * insufficient tip still rejects with the insufficient-balance path).
 */
export function totalBuzz(pools: { blue: number; green: number; yellow: number } | null): number | null {
  if (pools == null) return null;
  return pools.blue + pools.green + pools.yellow;
}
