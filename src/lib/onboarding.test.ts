import { describe, expect, it } from 'vitest';

import { hasSeenOnboarding, markOnboardingSeen } from './onboarding.js';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe('onboarding seen-flag', () => {
  it('is unseen on a fresh device, seen after marking', () => {
    const s = memStorage();
    expect(hasSeenOnboarding(s)).toBe(false);
    markOnboardingSeen(s);
    expect(hasSeenOnboarding(s)).toBe(true);
  });

  it('treats a null storage as already-seen (never nags without persistence)', () => {
    expect(hasSeenOnboarding(null)).toBe(true);
  });
});
