// THE one place the app decides which maturity ceiling it renders against.
//
// Today that is the DOMAIN ceiling the host projects into `BLOCK_INIT` as
// `maxBrowsingLevel` (civitai #2670), read through the SDK's `useDomainMaturity`.
// The platform is separately landing the VIEWER'S OWN browsing level into
// `BLOCK_INIT`; when it does, the effective ceiling becomes
// `min(domain, viewer)` — and this function is the only thing that has to
// change. Every surface calls it and nothing else reads `useDomainMaturity`.
//
// 🔴 IT RETURNS THE RAW BITMASK, NOT A PREDICATE, ON PURPOSE. A number is a
// stable dependency for the `useMemo`s that filter item lists; a freshly
// allocated predicate object would invalidate them on every render. Pair it with
// `withinCeiling` / `filterToCeiling` from ./maturity.js, which own the
// fail-closed policy for an absent mask.

import { useDomainMaturity } from '@civitai/blocks-react';

/**
 * The browsing-level ceiling bitmask this viewer may see, or `undefined` when the
 * host has not told us (pre-`BLOCK_INIT`, or a host predating civitai #2670).
 *
 * 🔴 `undefined` IS NOT "no limit" — it is "unknown", and every consumer must
 * treat it as SFW-only. `withinCeiling` does exactly that by delegating to the
 * SDK's own fail-closed `isLevelAllowed`.
 */
export function useViewerCeiling(): number | undefined {
  return useDomainMaturity().maxBrowsingLevel;
}
