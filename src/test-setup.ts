// Setup for the jsdom (component + hook + e2e) test project. Loaded via
// setupFiles in vite.config.ts's `dom` project.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetHarnessTransport } from './dev-transport.js';

// The SDK transport is a process-wide singleton — reset it before each test so
// each gets a fresh instance whose allowlist contains the jsdom origin, and so
// no BLOCK_INIT / token state leaks between tests.
beforeEach(() => {
  resetHarnessTransport();

  // jsdom has no matchMedia; default to a DESKTOP viewport. Tests that need the
  // mobile branch override this via `setViewport('mobile')` below.
  if (!window.matchMedia) {
    window.matchMedia = makeMatchMedia(false) as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Build a matchMedia stub where max-width queries report the given mobile-ness. */
export function makeMatchMedia(isMobile: boolean) {
  return (query: string) => {
    const isMaxWidth = /max-width/.test(query);
    const matches = isMaxWidth ? isMobile : !isMobile;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
}

/** Switch the jsdom viewport between mobile and desktop for the responsive branch. */
export function setViewport(kind: 'mobile' | 'desktop') {
  window.matchMedia = makeMatchMedia(kind === 'mobile') as typeof window.matchMedia;
}
