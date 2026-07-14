// Setup for the jsdom (component + hook + e2e) test project. Loaded via
// setupFiles in vite.config.ts's `dom` project.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetHarnessTransport } from './dev-transport.js';

// jsdom does not implement HTMLMediaElement.play/pause (it logs "Not
// implemented" + throws). The player guards the throw, but stub them as no-ops
// so the video-replay path doesn't spam the console.
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
}

// This jsdom build ships no `localStorage`, so install a simple in-memory one on
// globalThis (== window under jsdom) — the localStorage-backed player settings
// need a real Storage to exercise persistence.
if (typeof globalThis !== 'undefined' && !globalThis.localStorage) {
  const store = new Map<string, string>();
  const memoryLocalStorage: Storage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryLocalStorage,
    configurable: true,
    writable: true,
  });
}

// jsdom ships no IntersectionObserver. Install a controllable mock so lazy-cover
// swapping + infinite-scroll sentinel logic is deterministically testable:
// nothing intersects until a test calls `flushIntersections()`.
class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  private cb: IntersectionObserverCallback;
  elements = new Set<Element>();

  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.cb = cb;
    this.rootMargin = (opts?.rootMargin as string) ?? '';
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.elements.add(el);
  }
  unobserve(el: Element) {
    this.elements.delete(el);
  }
  disconnect() {
    this.elements.clear();
    const i = MockIntersectionObserver.instances.indexOf(this);
    if (i >= 0) MockIntersectionObserver.instances.splice(i, 1);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Deliver an intersection event for every currently-observed element. */
  fire(isIntersecting = true) {
    const entries = [...this.elements].map(
      (target) =>
        ({
          target,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          time: 0,
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRect: {} as DOMRectReadOnly,
          rootBounds: null,
        }) as IntersectionObserverEntry,
    );
    this.cb(entries, this);
  }
}

/** Fire intersection for every live observer (lazy covers + the grid sentinel). */
export function flushIntersections(isIntersecting = true) {
  for (const obs of [...MockIntersectionObserver.instances]) obs.fire(isIntersecting);
}

// The SDK transport is a process-wide singleton — reset it before each test so
// each gets a fresh instance whose allowlist contains the jsdom origin, and so
// no BLOCK_INIT / token state leaks between tests.
beforeEach(() => {
  resetHarnessTransport();
  MockIntersectionObserver.instances.length = 0;
  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;

  // Device-local player settings persist in localStorage; clear between tests so
  // a persisted pref doesn't leak into the next test's defaults.
  try {
    window.localStorage?.clear();
  } catch {
    /* ignore */
  }

  // jsdom has no matchMedia; default to a DESKTOP viewport. Tests that need the
  // mobile branch override this via `setViewport('mobile')` below.
  if (!window.matchMedia) {
    window.matchMedia = makeMatchMedia(false) as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
