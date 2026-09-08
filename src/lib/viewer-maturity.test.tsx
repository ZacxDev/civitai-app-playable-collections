// Cover for `useViewerCeiling` — THE one place the app decides which maturity
// ceiling it renders against.
//
// 🔴 THESE RUN AGAINST THE REAL SDK HOOK AND THE REAL MOCK HOST, NOT A MOCK OF
// `useDomainMaturity`. Mocking that hook would reduce every case below to
// "which property name does this module read", which is a fact about this file
// and not about what a viewer sees. The thing genuinely at risk is the WIRING:
// whether the host projects `effectiveBrowsingLevel` at all, and whether the
// SDK narrows with it. Only driving the host can answer that, and it is exactly
// the half that was inert while the app pinned `@civitai/blocks-react@0.48.0`.
//
// 🔴 THE FIRST CASE IS THE REGRESSION CASE and it must be read as one: before
// the swap this module returned `maxBrowsingLevel`, so it returned 31 for a
// viewer whose own setting is SFW-only. That is not a hypothetical — every
// viewer on the red domain receives the same maximally-wide domain ceiling, so
// the pre-swap app rendered mature media to a viewer who had turned it off.

import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { Harness } from '@civitai/blocks-react/testing';
import { BrowsingLevel, SFW_LEVELS } from '@civitai/app-sdk/blocks';

import { useViewerCeiling } from './viewer-maturity.js';

/** Every level bit a host can project — what `civitai.red` sends every viewer. */
const CEILING_ALL = SFW_LEVELS | BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX;

/**
 * Render the hook inside a host projecting an explicit DOMAIN ceiling and,
 * optionally, this viewer's own browsing level. Omitting either models a host
 * that does not send that field at all, which is a different case from sending
 * a wide one.
 */
function ceilingUnder(domain?: number, viewer?: number) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Harness
      showLog={false}
      {...(domain === undefined ? {} : { maxBrowsingLevel: domain })}
      {...(viewer === undefined ? {} : { viewerBrowsingLevel: viewer })}
    >
      {children}
    </Harness>
  );
  return renderHook(() => useViewerCeiling(), { wrapper });
}

describe('useViewerCeiling — the ceiling is the VIEWER’s, not the DOMAIN’s', () => {
  it('🔴 REGRESSION: a wide domain + an SFW viewer resolves to SFW, not to the domain ceiling', async () => {
    // Pre-swap this returned CEILING_ALL (31) — the value that renders X and
    // XXX media to someone whose own NSFW setting is off. Asserting the exact
    // number rather than `!== CEILING_ALL` so a future change that merely picks
    // some other wrong ceiling cannot pass.
    const { result } = ceilingUnder(CEILING_ALL, SFW_LEVELS);
    await waitFor(() => expect(result.current).toBe(SFW_LEVELS));
    expect(result.current).not.toBe(CEILING_ALL);
  });

  it('narrows to a viewer BELOW the SFW set, not merely to SFW', async () => {
    // A viewer capped at PG alone. Pinning this separately stops the module
    // passing by hardcoding `SFW_LEVELS`, which the case above cannot rule out.
    const { result } = ceilingUnder(CEILING_ALL, BrowsingLevel.PG);
    await waitFor(() => expect(result.current).toBe(BrowsingLevel.PG));
  });

  it('the DOMAIN still bounds a viewer who asks for more than the domain permits', async () => {
    // The intersection runs in both directions: a blue-domain viewer whose own
    // setting is wide gets the domain's SFW ceiling, never their own.
    const { result } = ceilingUnder(SFW_LEVELS, CEILING_ALL);
    await waitFor(() => expect(result.current).toBe(SFW_LEVELS));
    expect(result.current! & (BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX)).toBe(0);
  });

  it('a host that projects NO viewer level is unchanged — the domain ceiling, exactly', async () => {
    // The upgrade-safety property. Against a host predating civitai #4689 this
    // module must read exactly what it read before 0.49.0, or the swap is a
    // behaviour change for every viewer rather than a narrowing for some.
    const { result } = ceilingUnder(CEILING_ALL, undefined);
    await waitFor(() => expect(result.current).toBe(CEILING_ALL));
  });

  it('🔴 FAIL CLOSED — a host that projects NO ceiling at all returns undefined, not a number', async () => {
    // `undefined` is "unknown", and `withinCeiling` turns that into SFW-only.
    // Returning 0 or a number here would be a silently different policy.
    const { result } = ceilingUnder(undefined, undefined);
    // Give init a chance to land, then assert it never became a number.
    await waitFor(() => expect(result.current).toBeUndefined());
    expect(typeof result.current).not.toBe('number');
  });

  it('can only ever NARROW: the result is always a subset of the domain ceiling', async () => {
    // The property the whole upgrade rests on, stated as a property rather than
    // as three examples of it.
    for (const viewer of [SFW_LEVELS, BrowsingLevel.PG, CEILING_ALL, BrowsingLevel.R]) {
      const { result, unmount } = ceilingUnder(CEILING_ALL, viewer);
      await waitFor(() => expect(result.current).not.toBeUndefined());
      expect(result.current! & ~CEILING_ALL).toBe(0);
      unmount();
    }
  });
});
