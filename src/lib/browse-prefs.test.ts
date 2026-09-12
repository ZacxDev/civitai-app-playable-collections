// Pure-logic coverage for the browse-prefs record (the `node` project — no DOM,
// no host). The hook itself is exercised in `browse-prefs.test.tsx`.

import { describe, expect, it } from 'vitest';

import {
  BROWSE_PREFS_KEY,
  DEFAULT_BROWSE_PREFS,
  DEFAULT_SORT,
  coerceBrowsePrefs,
  isCollectionSort,
} from './browse-prefs.js';
import { DEFAULT_PERIOD } from './period.js';

describe('the defaults', () => {
  it('is Popular + This month — the pair a first visit lands on', () => {
    // Pinned literally rather than re-derived from the constants they mirror: a
    // test that reads `DEFAULT_SORT` to assert `DEFAULT_SORT` cannot fail.
    expect(DEFAULT_BROWSE_PREFS).toEqual({ sort: 'popular', period: 'month' });
  });

  it('is the same pair the two controls declare on their own', () => {
    // The relationship the record must not break: the defaults it restores to
    // are the defaults the controls would have shown anyway.
    expect(DEFAULT_BROWSE_PREFS.sort).toBe(DEFAULT_SORT);
    expect(DEFAULT_BROWSE_PREFS.period).toBe(DEFAULT_PERIOD);
  });

  it('namespaces its storage key to the app', () => {
    expect(BROWSE_PREFS_KEY).toBe('playable-collections:browse-prefs');
  });
});

describe('isCollectionSort', () => {
  it('admits exactly the two sorts', () => {
    expect(isCollectionSort('popular')).toBe(true);
    expect(isCollectionSort('newest')).toBe(true);
  });

  it('rejects everything else, including near-misses and non-strings', () => {
    for (const bad of ['Popular', 'newest ', 'oldest', '', null, undefined, 0, 1, {}, ['newest']]) {
      expect(isCollectionSort(bad)).toBe(false);
    }
  });
});

describe('coerceBrowsePrefs', () => {
  it('round-trips a fully valid record, both fields NON-default', () => {
    // Both values differ from their own defaults, so a stub returning the
    // defaults cannot pass this.
    expect(coerceBrowsePrefs({ sort: 'newest', period: 'year' })).toEqual({ sort: 'newest', period: 'year' });
  });

  it('returns the defaults for an unset key (null) — an anonymous viewer included', () => {
    expect(coerceBrowsePrefs(null)).toEqual(DEFAULT_BROWSE_PREFS);
    expect(coerceBrowsePrefs(undefined)).toEqual(DEFAULT_BROWSE_PREFS);
  });

  it('returns the defaults for values that are not records', () => {
    for (const bad of ['x', 42, true, ['newest', 'year']]) {
      expect(coerceBrowsePrefs(bad)).toEqual(DEFAULT_BROWSE_PREFS);
    }
  });

  it('🔴 degrades PER FIELD — a bad window does not cost a good sort', () => {
    // The whole point of per-field narrowing. A future version's unknown window
    // must not throw away a sort this build understands.
    expect(coerceBrowsePrefs({ sort: 'newest', period: 'fortnight' })).toEqual({
      sort: 'newest',
      period: DEFAULT_PERIOD,
    });
  });

  it('🔴 degrades PER FIELD in the other direction too', () => {
    // The mirror case, asserted separately: a guard whose description says
    // "per field" while the body only handles one side reads as coverage and
    // provides half.
    expect(coerceBrowsePrefs({ sort: 'sideways', period: 'day' })).toEqual({
      sort: DEFAULT_SORT,
      period: 'day',
    });
  });

  it('fills in a missing field rather than emitting undefined', () => {
    expect(coerceBrowsePrefs({ sort: 'newest' })).toEqual({ sort: 'newest', period: DEFAULT_PERIOD });
    expect(coerceBrowsePrefs({ period: 'week' })).toEqual({ sort: DEFAULT_SORT, period: 'week' });
  });

  it('ignores unknown extra fields instead of passing them through', () => {
    // A record from a future version carrying more than this build persists must
    // not leak that field back out into a wire param.
    const out = coerceBrowsePrefs({ sort: 'newest', period: 'day', layout: 'wall' });
    expect(Object.keys(out).sort()).toEqual(['period', 'sort']);
  });

  it('never throws, whatever it is handed', () => {
    for (const weird of [Symbol('s'), () => {}, new Map(), NaN]) {
      expect(() => coerceBrowsePrefs(weird)).not.toThrow();
    }
  });
});
