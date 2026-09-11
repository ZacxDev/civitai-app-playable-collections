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
//     its balance pre-check (it only compares when balance is non-null).
//
// 🔴 CORRECTION (measured 2026-09-11): AN EARLIER VERSION OF THIS BLOCK CALLED THE
// MISSING "You have N Buzz." LINE "the visible tell of the whole failure". THAT WAS
// WRONG, AND THE EXPERIMENT THAT REFUTES IT IS ONE PRESS. Consent was granted on a
// real account (all three scopes, `revoked_at` NULL) and the line STAYED ABSENT
// across a full reload — so the clause's absence did not track the grant at all.
//
// The actual gate at that time was AUTHORSHIP, not consent: the host's
// `blocks.getMyBuzzBalance` was gated on an author capability, so a viewer who was
// not the app's author got nothing back however much they had consented. That is
// why granting the scope changed nothing. civitai/civitai#4745 replaced the author
// capability with the viewer's own `buzz:read:self` consent ("the user's own grant
// is what authorizes this read now that the author capability no longer gates the
// runtime"), and on the SAME account the line then read "You have 297,893 Buzz."
//
// So the tell is only meaningful AFTER #4745, and even now it says "this token
// lacks the scope" — never "this viewer has not consented", because a declared-but-
// unrequested scope produces the identical absence. Do not reason backwards from a
// missing balance line to a missing grant.
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
