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
