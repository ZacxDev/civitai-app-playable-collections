// THE one place the app decides which maturity ceiling it renders against.
//
// It reads the ceiling in force for THIS VIEWER: the DOMAIN ceiling the host
// projects as `BLOCK_INIT.maxBrowsingLevel` (civitai #2670), intersected with
// the viewer's own browsing-level setting projected as `effectiveBrowsingLevel`
// (civitai #4689, surfaced to blocks by `@civitai/blocks-react` 0.49.0). The
// SDK does that intersection in `useDomainMaturity`; this module only chooses
// WHICH of the two numbers the app renders against. Every surface calls this
// function and nothing else reads `useDomainMaturity`.
//
// 🔴 `maxBrowsingLevel` IS THE WRONG NUMBER TO GATE ON, AND THAT IS WHY THIS
// MODULE EXISTS. It is a property of the DOMAIN, so every viewer on
// `civitai.red` receives the same maximally-wide ceiling — including one who
// turned their own NSFW setting off. Reading it renders mature media to a
// viewer who asked not to see any. `effectiveBrowsingLevel` is always a SUBSET
// of it, so this swap can only ever narrow what the app shows, never widen it.
//
// 🔴 IT RETURNS THE RAW BITMASK, NOT A PREDICATE, ON PURPOSE. A number is a
// stable dependency for the `useMemo`s that filter item lists; a freshly
// allocated predicate object would invalidate them on every render. Pair it with
// `withinCeiling` / `filterToCeiling` from ./maturity.js, which own the whole
// permit/refuse policy — this module knows only WHERE the ceiling comes from.
//
// 🔴 THIS FILE DECIDES NOTHING ABOUT CONTENT, AND THAT SEPARATION IS DELIBERATE.
// A ceiling is one input to the server's rule; the rule itself (unrated `0` is
// permitted at every ceiling, the test is bitwise INTERSECTION, unknowable input
// is refused) lives in ./maturity.js beside the SQL it mirrors. Putting any of it
// here would give the app two places to disagree with the platform from.

import { useDomainMaturity } from '@civitai/blocks-react';

/**
 * The browsing-level ceiling bitmask this viewer may see, or `undefined` when the
 * host has not told us (pre-`BLOCK_INIT`, or a host predating civitai #2670).
 *
 * 🔴 `undefined` IS NOT "no limit" — it is "unknown", and every consumer must
 * treat it as SFW-only. `withinCeiling` does exactly that: it falls back to the
 * SDK's own `SFW_LEVELS` constant, so the fail-closed default is the platform's
 * rather than a number this app chose.
 *
 * Against a host that projects a domain ceiling but NOT the per-viewer field
 * this returns the domain ceiling unchanged, so an older host behaves exactly
 * as it did before 0.49.0.
 */
export function useViewerCeiling(): number | undefined {
  return useDomainMaturity().effectiveBrowsingLevel;
}
