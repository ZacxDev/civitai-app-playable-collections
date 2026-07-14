// Small responsive helper. The player and grid branch their layout on a single
// mobile breakpoint so the branch is testable (tests stub matchMedia).

import { useEffect, useState } from 'react';

/** Mobile viewport threshold (inclusive max width). */
export const MOBILE_MAX_WIDTH = 640;

export function useMediaQuery(query: string): boolean {
  const getMatch = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;

  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    // addEventListener is the modern API; older Safari used addListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

/** True on a mobile-width viewport. Drives the swipe/keyboard + layout branch. */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
}

/**
 * True when the viewer asked the OS to reduce motion. 🔴 Gates the continuous
 * modes' ambient auto-scroll off (they fall back to plain user scrolling).
 */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
