// Block scope string constants used by the app at runtime (distinct from the
// manifest declaration, which is the source of truth for what the app REQUESTS).
//
// `collections:read:private` is CONSENT-GATED: the block-token mint WITHHOLDS it
// until the viewer grants it through the host consent UI (like
// `ai:write:budgeted`). Until then `useBlockToken().scopes` does NOT include it
// and the server omits the viewer's PRIVATE collections. `collections:read:self`
// is consent-exempt (public + own-public reads).

export const COLLECTIONS_READ_SELF = 'collections:read:self';
export const COLLECTIONS_READ_PRIVATE = 'collections:read:private';

/** Default predicate: does the current block token carry the private-read scope? */
export function defaultHasPrivateScope(tokenScopes: readonly string[]): boolean {
  return tokenScopes.includes(COLLECTIONS_READ_PRIVATE);
}

// ---- the money scopes ----
//
// 🔴 BOTH ARE CONSENT-GATED, AND A VIEWER WHO HAS NOT GRANTED THEM COULD NOT TIP
// AT ALL WHILE THE BUTTON LOOKED PERFECTLY FINE. Measured against the live app on
// 2026-09-08: the mint is FAIL-CLOSED on a missing `app_user_scope_grants` row, so
// the token silently arrived without either scope, and every leg of a real tip was
// refused by the server with the client showing only "not sent". Consent for
// `social:tip:self` existed on ONE row in that whole table, so this was the
// ORDINARY case for a viewer, not an edge one.
//
// The two symptoms are one cause, which is why they are declared together:
//   - `social:tip:self` withheld → POST /api/v1/blocks/tip is rejected at the
//     scope gate, before the money layer. Nothing reaches the Buzz ledger.
//   - `buzz:read:self` withheld  → the balance read returns nothing, so the
//     picker renders with no "You have N Buzz" line AND `validateTipSplit` skips
//     its balance pre-check (it only compares when balance is non-null). The
//     missing line is the visible tell of the whole failure.
export const SOCIAL_TIP_SELF = 'social:tip:self';
export const BUZZ_READ_SELF = 'buzz:read:self';

/**
 * Default predicate: may this token actually send a tip?
 *
 * 🔴 KEYED ON `social:tip:self` ALONE, DELIBERATELY. `buzz:read:self` is requested
 * alongside it because a picker that cannot show a balance is a worse experience,
 * but it is NOT required to send — a null balance degrades to "no local
 * pre-block", which is the documented posture. Requiring both here would refuse
 * to open the picker for a viewer who granted tipping and declined the balance
 * read, i.e. it would block a tip the server would have accepted.
 */
export function defaultHasTipScope(tokenScopes: readonly string[]): boolean {
  return tokenScopes.includes(SOCIAL_TIP_SELF);
}
