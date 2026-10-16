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
//
// MIGRATION (Phase 3): the shared store above is DEPRECATED platform-wide in
// favour of the document store, so popularity is moving to a declared
// collection — `popular_plays`, shared, `write: "none"`, one counter
// (`plays`) and one mark (`played`) — declared in `block.manifest.json` under
// `storage.collections` and reached via `app.storage.collection(...)` behind
// the `apps:storage` scope. The model maps one-to-one:
//
//   • ONE document per collection, keyed by the collection id itself.
//   • "playing" = setting the viewer's `played` MARK on that document — a
//     mark is the platform's own replacement for a shared-store vote
//     (at most one per viewer per document, idempotent), so the count a
//     reader sees is still DISTINCT viewers, never raw plays.
//   • the counter exists because a mark cannot create its document: in a
//     `write: "none"` collection the first INCREMENT of a missing key is the
//     only creation there is. `plays` therefore tallies raw plays (replays
//     included) and NOTHING ranks on it; the rail ranks on the mark count,
//     exactly as it ranked on the vote count.
//
// The move is DUAL-READ and gated, because the platform gives no other safe
// shape: a declared collection exists only once the version declaring it is
// APPROVED, and legacy data is never copied across ("nothing is copied for
// you" — the storage guide's migration section). So until approval the app
// runs the legacy path untouched (the token does not even carry
// `apps:storage` — see `defaultHasDocStoreScope` in `src/scopes.ts`), and
// after approval every read merges both stores with the document store
// winning per collection, while every write goes to the document store with
// the legacy vote kept as the fallback for a failed doc write. A collection
// whose plays all predate the migration keeps its legacy count until its
// first post-migration play creates its document — from then on its count is
// its post-migration distinct viewers. That discontinuity is the platform's
// own ("legacy vote counts cannot become marks; they start at zero"), not a
// choice made here: the alternative — summing the two — would count a viewer
// who played on both sides of the migration twice.

// Types come from `@civitai/sdk` now, not the bridge package: `SharedValue` is the
// contributed `{ title, body?, data? }` and `SharedItem` is one listed row. Both are
// field-for-field the shapes the bridge declared, so nothing below changes — but the
// import is what actually moves this module off `@civitai/blocks-react`.
import type { SharedItem, StorageCollection } from '@civitai/sdk';

import type { SharedStorageFacade } from './sdk-runtime.js';

/**
 * Alias kept so the rest of this file (and its tests) read unchanged.
 *
 * `SharedAppendValue` is deliberately NOT aliased any more: it named the shape of a
 * row we READ, and the port's whole correction is that a read row's value is
 * `unknown`. Keeping the alias would have let that assumption back in by the side
 * door — see `entryCollectionId`.
 */
type SharedListItem = SharedItem;

import type { CollectionPage, CollectionSummary, PopularEntry } from '../types.js';

/** The SHARED-store surface the popularity helpers need (subset of the hook). */
export type SharedStore = Pick<SharedStorageFacade, 'list' | 'append' | 'vote'>;

/** Read-only slice — `readPopular` only lists. */
export type SharedReadStore = Pick<SharedStorageFacade, 'list'>;

/**
 * How many SHARED entries to pull when ranking. The store's `list()` is
 * newest-first (not count-sorted), so we fetch a bounded page and rank
 * client-side — fine for a nice-to-have discovery rail with a modest entry set.
 */
const LIST_LIMIT = 200;

/** Host title cap is generous; keep our synthesized title short + safe. */
const MAX_TITLE = 120;

/**
 * Pull the app-owned `collectionId` back out of an entry's opaque `data` blob.
 *
 * 🔴 THE PARAMETER IS `unknown`, AND THE PORT IS WHY — THIS IS A TIGHTENING, NOT A
 * LOOSENING. The bridge declared a listed row's `value` as the same
 * `{ title, body?, data? }` shape an append sends; `@civitai/sdk` declares it
 * `unknown`, with the reason in its own docblock: the row "was written by some OTHER
 * viewer's copy of this app — possibly an older version, possibly a newer one — so
 * its shape is a fact about the data, not a promise this client can make". That is
 * right, and this function was already written as if it were — every field access
 * below is guarded. So the signature now says what the body always did, and the
 * compiler stops anyone reaching for `value.title` on a row we did not write.
 */
export function entryCollectionId(value: unknown): number | null {
  const data = value && typeof value === 'object' ? (value as { data?: unknown }).data : undefined;
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

// ---------------------------------------------------------------------------
// The document store — the same popularity, on `popular_plays`
// ---------------------------------------------------------------------------

/**
 * The declared collection's name. It must match `storage.collections` in
 * `block.manifest.json` EXACTLY: the server reads the approved manifest, and
 * a name it does not declare is refused `collection_not_declared` — which the
 * migration path reads as "not migrated yet", so a typo here would silently
 * pin the app to the legacy store forever. `popular.test.ts` builds its fake
 * store from the committed manifest itself, so the two cannot drift apart
 * without a red test.
 */
export const POPULAR_PLAYS_COLLECTION = 'popular_plays';

/** The raw-plays counter. Creation mechanism only — nothing ranks on it. */
export const PLAYS_COUNTER = 'plays';

/** The per-viewer mark whose COUNT is the popularity (distinct viewers). */
export const PLAYED_MARK = 'played';

/** The document-store slice the migrated helpers need (subset of the handle). */
export type PlaysStore = Pick<StorageCollection, 'list' | 'increment' | 'mark'>;

/** Read-only slice — `readPopularDoc` only lists. */
export type PlaysReadStore = Pick<StorageCollection, 'list'>;

/**
 * The largest page the store serves. Two pages bound a migrated read the way
 * `LIST_LIMIT` bounds a legacy one, so the merge below ranks over the same
 * horizon the legacy read always had.
 */
const DOC_PAGE_LIMIT = 100;

/** A collection's document key: the id itself, as a decimal string. */
function playsKey(collectionId: number): string {
  return String(collectionId);
}

/**
 * Record that the viewer played `collection`, in the document store:
 * increment the `plays` counter (which creates the document when this is the
 * collection's first recorded play), then set the viewer's `played` mark.
 *
 * 🔴 THE ORDER IS THE PLATFORM'S, NOT A PREFERENCE. A mark on a key with no
 * document is refused `not_found` (measured against the SDK's own fake store,
 * which enforces the server's rules); in a `write: "none"` collection the
 * counter increment is the only creation there is. The mark is idempotent
 * per viewer, so a replay moves only the counter and the popularity count —
 * the mark's — does not inflate: the legacy vote's invariant, preserved.
 *
 * Requires a signed-in viewer and the `apps:storage` scope; rejects with the
 * store's error (`sign_in_required`, `collection_not_declared`,
 * `not_eligible`, …) and the caller decides what a rejection means — see
 * `recordPlayMigrated`.
 */
export async function recordPlayDoc(plays: PlaysStore, collection: { id: number }): Promise<void> {
  const key = playsKey(collection.id);
  await plays.increment(key, PLAYS_COUNTER);
  await plays.mark(key, PLAYED_MARK);
}

/**
 * The top-N most-played collections by DISTINCT-viewer mark count (desc),
 * from the document store alone. Reads ranked pages (`sort: '-mark:played'`
 * is a server sort over the declared mark, missing tallies counting as 0) up
 * to the same 200-document horizon as the legacy read, and drops documents
 * nobody has marked — a document can exist with a zero mark count when its
 * creating increment landed but the mark did not, and zero is not popularity
 * in either store.
 */
export async function readPopularDoc(plays: PlaysReadStore, limit: number): Promise<PopularEntry[]> {
  const entries: PopularEntry[] = [];
  let cursor: string | undefined;
  // At most two pages: the horizon above, stated as a page count so a store
  // full of unparseable keys cannot page this read forever.
  for (let pageNo = 0; pageNo < LIST_LIMIT / DOC_PAGE_LIMIT; pageNo += 1) {
    const page = await plays.list({
      sort: `-mark:${PLAYED_MARK}`,
      limit: DOC_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const doc of page.items) {
      const collectionId = Number(doc.key);
      const count = doc.marks[PLAYED_MARK] ?? 0;
      if (Number.isInteger(collectionId) && collectionId > 0 && count > 0) {
        entries.push({ collectionId, count });
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return entries.sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * Merge the two stores' rankings into one: the document store's count wins
 * for any collection it has a count for, and a collection it has never heard
 * of keeps its legacy count. Ranked desc and sliced AFTER the merge — slicing
 * either input at the rail's limit first would drop exactly the entries the
 * other store's shadowing promotes.
 */
export function mergePopular(
  docEntries: readonly PopularEntry[],
  legacyEntries: readonly PopularEntry[],
  limit: number,
): PopularEntry[] {
  const byId = new Map<number, PopularEntry>();
  for (const e of legacyEntries) byId.set(e.collectionId, e);
  for (const e of docEntries) byId.set(e.collectionId, e);
  return [...byId.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * The play write the app actually makes. With a document store available
 * (`plays` non-null — the caller gates that on the token carrying
 * `apps:storage`), the write goes there and the legacy store is not touched:
 * the write has MOVED. Any doc-store rejection — the collection not yet
 * existing, the store disabled, the viewer ineligible — falls back to the
 * legacy vote, so a play is recorded somewhere whenever it can be; the
 * rejection this function can still surface is the legacy write's own, which
 * is exactly the contract `recordPlay` always had.
 */
export async function recordPlayMigrated(
  plays: PlaysStore | null,
  shared: SharedStore,
  collection: { id: number; name: string },
): Promise<void> {
  if (plays) {
    try {
      await recordPlayDoc(plays, collection);
      return;
    } catch {
      // Not migrated yet, or the store refused: the legacy vote below is the
      // pre-migration behaviour, kept whole. Popularity is best-effort and
      // the caller swallows even this fallback's failure.
    }
  }
  await recordPlay(shared, collection);
}

/**
 * The rail read the app actually makes: both stores, merged by
 * `mergePopular`. A document store that rejects (not yet approved, disabled,
 * a transient 503) contributes NOTHING rather than failing the read — the
 * legacy ranking alone is precisely what the rail showed before the
 * migration. The legacy read keeps its old contract: if IT rejects, this
 * rejects, and the caller empties the rail as it always did.
 */
export async function readPopularMigrated(
  plays: PlaysReadStore | null,
  shared: SharedReadStore,
  limit: number,
): Promise<PopularEntry[]> {
  const legacy = await readPopular(shared, LIST_LIMIT);
  if (!plays) return legacy.slice(0, limit);
  let doc: PopularEntry[] = [];
  try {
    doc = await readPopularDoc(plays, LIST_LIMIT);
  } catch {
    doc = [];
  }
  return mergePopular(doc, legacy, limit);
}

/** One resolved rail entry: a full collection card + its distinct-viewer play count. */
/**
 * 🔴 THE RAIL MUST EARN ITS HEADING. Measured live 2026-09-05, the five cards on
 * `🔥 Popular right now` read **6, 1, 1, 1, 1 plays** — a ranking in which four
 * of five entries are tied at the minimum possible non-zero value. That is not a
 * popularity signal; it is the app's own play counter with almost nothing in it,
 * presented as one, on the most prominent surface after the title.
 *
 * Two thresholds, because one does not cover it:
 *
 * - {@link POPULAR_MIN_PLAYS} — a SINGLE play cannot distinguish "people like
 *   this" from "someone opened it once", including the author testing their own
 *   entry. Two is the smallest count that can mean a return visit or a second
 *   person.
 * - {@link POPULAR_MIN_ENTRIES} — a "rail" of one or two cards is not a ranking,
 *   it is a list with a superlative over it. Three is the smallest set in which
 *   an ORDER carries information.
 *
 * 🔴 BELOW EITHER, THE RAIL RENDERS NOTHING AT ALL — no heading, and deliberately
 * no copy explaining the absence. An explanation would re-raise exactly the thing
 * the threshold exists to suppress, and an absent rail asks no questions: the
 * Discover grid below is a complete front door on its own.
 */
export const POPULAR_MIN_PLAYS = 2;

/** @see POPULAR_MIN_PLAYS */
export const POPULAR_MIN_ENTRIES = 3;

/**
 * The entries the popular rail may show, or an EMPTY ARRAY when the data does
 * not support the claim the heading makes.
 *
 * Returning `[]` rather than a boolean is deliberate: `PopularRail` already
 * renders nothing for an empty list, so the threshold reuses the one hiding
 * mechanism that exists instead of adding a second one that could disagree with
 * it.
 *
 * 🔴 The filter runs BEFORE the count check, so entries below the play floor
 * cannot pad the set to reach the entry floor — six one-play entries stay hidden.
 */
export function popularRailEntries<T extends { count: number }>(entries: readonly T[]): T[] {
  const qualifying = entries.filter((e) => e.count >= POPULAR_MIN_PLAYS);
  return qualifying.length >= POPULAR_MIN_ENTRIES ? qualifying : [];
}

export interface ResolvedPopular {
  collection: CollectionSummary;
  count: number;
}

/**
 * Synthesize a grid `CollectionSummary` from a collection-DETAIL page. Used to
 * resolve a popular id that isn't on any loaded list (the detail endpoint is the
 * only by-id read). The rail card shows name + cover + play count only, so a
 * cover derived from the first item and an approximate `itemCount` (the loaded
 * page length — the resolver fetches with `limit: 1`) are sufficient; the exact
 * count is never displayed on the rail.
 */
export function summaryFromPage(page: CollectionPage): CollectionSummary {
  const { collection, items } = page;
  // Gate the cover by the highest-rated LOADED item (fail-closed-friendly): the
  // cover thumbnail should never be less-blurred than the media it represents.
  const coverNsfwLevel = items.length ? Math.max(...items.map((it) => it.nsfwLevel ?? 0)) : undefined;
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    coverImageUrl: items[0]?.url ?? null,
    itemCount: items.length,
    curator: collection.curator,
    isPublic: collection.isPublic,
    followed: collection.followed,
    coverNsfwLevel,
  };
}

/**
 * Resolve ranked popular entries to full collection cards.
 *
 * 🔴 THE FIX (v0.1.9): the old resolver looked ids up ONLY in the already-loaded
 * discover/mine map (`known`), so a genuinely popular collection that happened
 * not to be on the current page was silently dropped from the rail — the
 * headline cross-user signal quietly degrading. Now an id absent from `known` is
 * fetched via `fetchSummary` (the by-id detail endpoint), so the rail always
 * shows the TRUE top-N. Rank order (the input order — already count-desc) is
 * preserved; an id that can't be resolved (404 / hidden / fetch error →
 * `fetchSummary` returns null or throws) is dropped, never crashes the rail.
 */
export async function resolvePopularEntries(
  entries: PopularEntry[],
  known: Map<number, CollectionSummary>,
  fetchSummary: (id: number) => Promise<CollectionSummary | null>,
): Promise<ResolvedPopular[]> {
  const settled = await Promise.all(
    entries.map(async (e): Promise<ResolvedPopular | null> => {
      const hit = known.get(e.collectionId);
      if (hit) return { collection: hit, count: e.count };
      try {
        const summary = await fetchSummary(e.collectionId);
        return summary ? { collection: summary, count: e.count } : null;
      } catch {
        return null;
      }
    }),
  );
  return settled.filter((x): x is ResolvedPopular => x !== null);
}

/**
 * The viewer's single spendable Buzz figure for the tip modal's soft ceiling
 * (it also fed a header pill until that readout was removed 2026-09-05 — the
 * modal is now the only consumer). `useBuzzBalance()` returns per-pool balances
 * (`{ blue, green, yellow }`); we sum them for a "your Buzz" total. Over- rather
 * than under-reporting is the safe direction: the soft client check never falsely
 * blocks a valid tip, and the SERVER stays authoritative (a genuinely
 * insufficient tip still rejects with the insufficient-balance path).
 */
export function totalBuzz(pools: { blue: number; green: number; yellow: number } | null): number | null {
  if (pools == null) return null;
  return pools.blue + pools.green + pools.yellow;
}
