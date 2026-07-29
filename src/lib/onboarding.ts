// One-time onboarding / controls hint (Feature #10).
//
// Shows a short coach the FIRST time a viewer opens a collection — the three
// view modes, press-hold-to-pause (continuous), and tap-to-lightbox — then never
// again (a localStorage flag). Device-local, no scopes.

import { useCallback, useState } from 'react';

import { getLocalStorage } from '../settings.js';

const KEY = 'playable-collections:onboarded';

/** Has the viewer already seen the coach? No storage → treat as seen (don't nag). */
export function hasSeenOnboarding(storage: Storage | null = getLocalStorage()): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(KEY) === '1';
  } catch {
    return true;
  }
}

/** Persist that the coach has been seen. */
export function markOnboardingSeen(storage: Storage | null = getLocalStorage()): void {
  try {
    storage?.setItem(KEY, '1');
  } catch {
    /* ignore */
  }
}

/** Hook: whether to show the coach + a dismiss that records it as seen. */
export function useOnboarding(storage: Storage | null = getLocalStorage()): { show: boolean; dismiss: () => void } {
  const [show, setShow] = useState<boolean>(() => !hasSeenOnboarding(storage));
  const dismiss = useCallback(() => {
    markOnboardingSeen(storage);
    setShow(false);
  }, [storage]);
  return { show, dismiss };
}
