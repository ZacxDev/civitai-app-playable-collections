// Official-account filtering for the public browse surfaces.
//
// Zacx's direction (2026-10-17): collections from Civitai official / Civitai
// accounts do not belong in this app's discovery surfaces — the app is a
// viewer-curated lens on the corpus, and the platform's own collections
// crowding it is noise, not discovery.
//
// ---------------------------------------------------------------------------
// 🔴 WHAT THE DATA ACTUALLY CARRIES — AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// A collection's owner reaches this app in exactly one shape:
// `CollectionSummary.curator: { userId, username }` (src/types.ts, which
// mirrors the list/detail wire payloads — the HTTP client casts the response
// to those types without remapping). There is NO official / staff / system
// flag anywhere in the payload the app receives, and no in-repo source pins
// the official account's numeric userId — `userId` is therefore deliberately
// NOT part of the rule below: hardcoding an id learned from outside the data
// would be inventing a field the contract does not state.
//
// The rule the data supports is the username: the platform's official account
// publishes as `Civitai`. The match is EXACT (after trim + case-folding —
// Civitai usernames are case-insensitively unique, so the fold cannot catch a
// different account) — a prefix or substring rule would also hide lookalike
// fan accounts (`civitaiart`, `CivitaiFan`), which are ordinary creators this
// app exists to surface.
//
// If the platform ever ships an official/staff marker on the payload, THIS
// predicate is the one place to strengthen; every surface consumes it.

import type { CollectionSummary, UserRef } from '../types.js';

/** Usernames (case-folded) that mark a collection as platform-official. */
export const OFFICIAL_USERNAMES: ReadonlySet<string> = new Set(['civitai']);

/** Is this user reference a Civitai official account? */
export function isOfficialAccount(user: UserRef | null | undefined): boolean {
  const name = user?.username?.trim().toLowerCase();
  return name != null && name !== '' && OFFICIAL_USERNAMES.has(name);
}

/** Is this collection curated by a Civitai official account? */
export function isOfficialCollection(summary: CollectionSummary): boolean {
  return isOfficialAccount(summary.curator);
}
