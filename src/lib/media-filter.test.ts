import { describe, expect, it } from 'vitest';

import { FILL_TARGET, filterByType, MEDIA_FILTERS, needsMoreToFill } from './media-filter.js';
import type { MediaItem } from '../types.js';

function img(id: number): MediaItem {
  return { mediaId: id, type: 'image', url: `i/${id}`, width: 1, height: 1, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}
function vid(id: number): MediaItem {
  return { mediaId: id, type: 'video', url: `v/${id}`, width: 1, height: 1, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}

describe('filterByType', () => {
  const items = [img(1), vid(2), img(3), vid(4)];
  it('returns the input unchanged for "all"', () => {
    expect(filterByType(items, 'all')).toBe(items);
  });
  it('keeps only images', () => {
    expect(filterByType(items, 'images').map((i) => i.mediaId)).toEqual([1, 3]);
  });
  it('keeps only videos', () => {
    expect(filterByType(items, 'videos').map((i) => i.mediaId)).toEqual([2, 4]);
  });
  it('exposes the three filter options', () => {
    expect(MEDIA_FILTERS).toEqual(['all', 'images', 'videos']);
  });
});

describe('needsMoreToFill', () => {
  it('never pages when the filter is "all"', () => {
    expect(needsMoreToFill('all', 0, true, false)).toBe(false);
  });
  it('pages when a filter is active, matches are below target, and more pages exist', () => {
    expect(needsMoreToFill('videos', 0, true, false)).toBe(true);
    expect(needsMoreToFill('images', FILL_TARGET - 1, true, false)).toBe(true);
  });
  it('stops once enough matches are visible', () => {
    expect(needsMoreToFill('videos', FILL_TARGET, true, false)).toBe(false);
  });
  it('does not page when no more pages exist (bounded by the loader)', () => {
    expect(needsMoreToFill('videos', 0, false, false)).toBe(false);
  });
  it('does not page when a fetch is already in flight', () => {
    expect(needsMoreToFill('videos', 0, true, true)).toBe(false);
  });
  it('respects a custom target', () => {
    expect(needsMoreToFill('images', 3, true, false, 3)).toBe(false);
    expect(needsMoreToFill('images', 2, true, false, 3)).toBe(true);
  });
});
