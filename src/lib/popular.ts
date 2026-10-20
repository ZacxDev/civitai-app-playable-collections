// Cross-user "popular collections" popularity, backed by the App Blocks
// DOCUMENT STORE's `popular_plays` collection — shared, `write: "none"`, one
// counter (`plays`) and one mark (`played`) — declared in
// `block.manifest.json` under `storage.collections` and reached via
// `app.storage.collection(...)` behind the `apps:storage` scope.
//
//   • ONE document per collection, keyed by the collection id itself.
//   • "playing" = setting the viewer's `played` MARK on that document — at
//     most one per viewer per document, idempotent — so a collection's
//     popularity is its count of DISTINCT viewers, never raw plays.
//   • the counter exists because a mark cannot create its document: in a
//     `write: "none"` collection the first INCREMENT of a missing key is the
//     only creation there is. `plays` therefore tallies raw plays (replays
//     included) and NOTHING ranks on it; the rail ranks on the mark count.
//
// 🔴 THIS IS THE ONLY STORE. Until 0.3.0 the rail DUAL-READ this collection
// and the legacy shared key/value store (`/api/v1/blocks/shared-storage/*`,
// one `{ title, data: { collectionId } }` entry per collection, one vote per
// viewer), merging the legacy counts in and falling back to a legacy vote when
// a document-store write failed. That surface is being deleted platform-wide,
// so the legacy read, the legacy write and the merge are gone. The legacy rows
// are NOT abandoned: they move into this collection by a separate, hand-run
// copy at cutover (one document per legacy entry, key = its `collectionId`,
// each legacy vote becoming that viewer's `played` mark, the legacy tally
// seeding `plays`). That copy writes exactly the shape `recordPlayDoc` below
// writes, so the key rule (`playsKey`) and the counter/mark names are a
// contract with it — change one and the copied history is stranded.
//
// The functions take only the store slice they use, so they are pure and
// unit-testable against the SDK's own fake store (see popular.test.ts).

import type { StorageCollection } from '@civitai/sdk';

import type { CollectionPage, CollectionSummary, PopularEntry } from '../types.js';

/**
 * How many documents a rail read ranks over at most — two pages of the
 * store's largest page. Fine for a nice-to-have discovery rail with a modest
 * entry set.
 */
const LIST_LIMIT = 200;

/**
 * The declared collection's name. It must match `storage.collections` in
 * `block.manifest.json` EXACTLY: the server reads the approved manifest, and
 * a name it does not declare is refused `collection_not_declared` — which
 * every caller swallows, so a typo here would silently empty the rail
 * forever. `popular.test.ts` builds its fake store from the committed
 * manifest itself, so the two cannot drift apart without a red test.
 */
export const POPULAR_PLAYS_COLLECTION = 'popular_plays';

/** The raw-plays counter. Creation mechanism only — nothing ranks on it. */
export const PLAYS_COUNTER = 'plays';

/** The per-viewer mark whose COUNT is the popularity (distinct viewers). */
export const PLAYED_MARK = 'played';

/** The document-store slice the helpers need (subset of the handle). */
export type PlaysStore = Pick<StorageCollection, 'list' | 'increment' | 'mark'>;

/** Read-only slice — `readPopularDoc` only lists. */
export type PlaysReadStore = Pick<StorageCollection, 'list'>;

/** The largest page the store serves. */
const DOC_PAGE_LIMIT = 100;

/** A collection's document key: the id itself, as a decimal string. */
function playsKey(collectionId: number): string {
  return String(collectionId);
}

/**
 * Record that the viewer played `collection`: increment the `plays` counter
 * (which creates the document when this is the collection's first recorded
 * play), then set the viewer's `played` mark.
 *
 * 🔴 THE ORDER IS THE PLATFORM'S, NOT A PREFERENCE. A mark on a key with no
 * document is refused `not_found` (measured against the SDK's own fake store,
 * which enforces the server's rules); in a `write: "none"` collection the
 * counter increment is the only creation there is. The mark is idempotent
 * per viewer, so a replay moves only the counter and the popularity count —
 * the mark's — does not inflate.
 *
 * Requires a signed-in viewer and the `apps:storage` scope; rejects with the
 * store's error (`sign_in_required`, `collection_not_declared`,
 * `not_eligible`, …). Callers treat popularity as best-effort.
 */
export async function recordPlayDoc(plays: PlaysStore, collection: { id: number }): Promise<void> {
  const key = playsKey(collection.id);
  await plays.increment(key, PLAYS_COUNTER);
  await plays.mark(key, PLAYED_MARK);
}

/**
 * The top-N most-played collections by DISTINCT-viewer mark count (desc).
 * Reads ranked pages (`sort: '-mark:played'` is a server sort over the
 * declared mark, missing tallies counting as 0) up to `LIST_LIMIT` documents
 * and drops documents nobody has marked — a document can exist with a zero
 * mark count when its creating increment landed but the mark did not, and
 * zero is not popularity.
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
 * The play write the app makes. `plays` is null when the token does not carry
 * `apps:storage` (see `defaultHasDocStoreScope` in `src/scopes.ts`): there is
 * then nowhere to record a play, and this resolves without a request — there
 * is no legacy store to fall back to any more. Otherwise it is
 * `recordPlayDoc`, rejection included.
 */
export async function recordPlay(plays: PlaysStore | null, collection: { id: number }): Promise<void> {
  if (!plays) return;
  await recordPlayDoc(plays, collection);
}

/**
 * The rail read the app makes: the document store alone. `null` (no
 * `apps:storage` on the token) is an empty rail without a request; a store
 * rejection propagates, and the caller empties the rail.
 */
export async function readPopular(plays: PlaysReadStore | null, limit: number): Promise<PopularEntry[]> {
  if (!plays) return [];
  return readPopularDoc(plays, limit);
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
