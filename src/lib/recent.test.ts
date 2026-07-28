import { describe, expect, it } from 'vitest';

import { MAX_RECENT, readRecent, recordRecent } from './recent.js';

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

const col = (id: number, name = `C${id}`) => ({ id, name, coverImageUrl: `https://x/${id}.jpg` });

describe('recordRecent / readRecent', () => {
  it('records most-recent-first', () => {
    const s = memStorage();
    recordRecent(col(1), s);
    recordRecent(col(2), s);
    expect(readRecent(s).map((e) => e.id)).toEqual([2, 1]);
  });

  it('dedupes by id, moving a replay to the front', () => {
    const s = memStorage();
    recordRecent(col(1), s);
    recordRecent(col(2), s);
    recordRecent(col(1), s);
    expect(readRecent(s).map((e) => e.id)).toEqual([1, 2]);
  });

  it('caps the list at MAX_RECENT', () => {
    const s = memStorage();
    for (let i = 1; i <= MAX_RECENT + 5; i += 1) recordRecent(col(i), s);
    const list = readRecent(s);
    expect(list).toHaveLength(MAX_RECENT);
    // The newest MAX_RECENT survive; the oldest are dropped.
    expect(list[0].id).toBe(MAX_RECENT + 5);
    expect(list.some((e) => e.id === 1)).toBe(false);
  });

  it('preserves the display fields', () => {
    const s = memStorage();
    recordRecent({ id: 7, name: 'Neon', coverImageUrl: null }, s);
    expect(readRecent(s)[0]).toEqual({ id: 7, name: 'Neon', coverImageUrl: null });
  });

  it('returns [] for empty / corrupt storage', () => {
    const s = memStorage();
    expect(readRecent(s)).toEqual([]);
    s.setItem('playable-collections:recent', 'not json');
    expect(readRecent(s)).toEqual([]);
    s.setItem('playable-collections:recent', JSON.stringify([{ nope: true }, 5]));
    expect(readRecent(s)).toEqual([]);
    expect(readRecent(null)).toEqual([]);
  });
});
