import { describe, expect, it } from 'vitest';

import { assignColumns, columnCount, itemHeightWeight } from './columns.js';

describe('columnCount (responsive, mobile-first)', () => {
  it('degrades 3 → 2 → 1 as width narrows', () => {
    expect(columnCount(1200)).toBe(3);
    expect(columnCount(900)).toBe(3);
    expect(columnCount(899)).toBe(2);
    expect(columnCount(520)).toBe(2);
    expect(columnCount(519)).toBe(1);
    expect(columnCount(320)).toBe(1);
  });
  it('falls back to 1 for an unknown/zero width', () => {
    expect(columnCount(0)).toBe(1);
    expect(columnCount(-5)).toBe(1);
  });
});

describe('itemHeightWeight', () => {
  it('is the aspect ratio (height/width)', () => {
    expect(itemHeightWeight({ width: 100, height: 200 })).toBe(2);
    expect(itemHeightWeight({ width: 200, height: 100 })).toBe(0.5);
  });
  it('guards missing dimensions', () => {
    expect(itemHeightWeight({ width: 0, height: 100 })).toBe(1);
    expect(itemHeightWeight({ width: 100, height: 0 })).toBe(1);
  });
});

describe('assignColumns (balanced masonry)', () => {
  const square = (id: number) => ({ mediaId: id, width: 100, height: 100 });

  it('distributes square items round-robin across the columns', () => {
    const items = [1, 2, 3, 4, 5, 6].map(square);
    const cols = assignColumns(items, 3);
    expect(cols).toHaveLength(3);
    expect(cols.map((c) => c.map((i) => i.mediaId))).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
  });

  it('keeps every item exactly once (no loss/dupe)', () => {
    const items = Array.from({ length: 17 }, (_, i) => square(i + 1));
    const cols = assignColumns(items, 3);
    const flat = cols.flat().map((i) => i.mediaId).sort((a, b) => a - b);
    expect(flat).toEqual(items.map((i) => i.mediaId));
  });

  it('balances by height — a tall item makes its column skip the next pick', () => {
    // col0 gets a very tall item first; the next items should avoid col0 until
    // the other columns catch up in accumulated height.
    const items = [
      { mediaId: 1, width: 100, height: 400 }, // weight 4 → col0
      { mediaId: 2, width: 100, height: 100 }, // weight 1 → col1
      { mediaId: 3, width: 100, height: 100 }, // weight 1 → col2 (col0 still tallest)
      { mediaId: 4, width: 100, height: 100 }, // → col1 (heights: col0=4,col1=1,col2=1)
    ];
    const cols = assignColumns(items, 3);
    expect(cols[0].map((i) => i.mediaId)).toEqual([1]);
    expect(cols[1].map((i) => i.mediaId)).toEqual([2, 4]);
    expect(cols[2].map((i) => i.mediaId)).toEqual([3]);
  });

  it('handles fewer items than columns (empty trailing columns)', () => {
    const cols = assignColumns([square(1)], 3);
    expect(cols.map((c) => c.length)).toEqual([1, 0, 0]);
  });

  it('coerces a bad column count to at least 1', () => {
    expect(assignColumns([square(1), square(2)], 0)).toEqual([[square(1), square(2)]]);
  });
});
