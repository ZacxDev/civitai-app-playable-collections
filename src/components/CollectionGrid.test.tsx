import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CollectionGrid } from './CollectionGrid.js';
import { palette } from '../theme.js';
import type { CollectionSummary } from '../types.js';

const c = palette(true);

function summary(over: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id: 1,
    name: 'A collection',
    description: null,
    coverImageUrl: null,
    itemCount: 3,
    curator: { userId: 1, username: 'alice' },
    isPublic: true,
    followed: false,
    ...over,
  };
}

function renderGrid(collections: CollectionSummary[]) {
  return render(
    <CollectionGrid
      collections={collections}
      loading={false}
      error={null}
      emptyLabel="empty"
      onOpen={vi.fn()}
      c={c}
      isMobile={false}
    />,
  );
}

describe('CollectionGrid cover rendering (feedback #2)', () => {
  it('renders the ▶ placeholder tile (no <img>) when coverImageUrl is null', () => {
    renderGrid([summary({ coverImageUrl: null })]);
    expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('treats an empty-string coverImageUrl as no cover (placeholder, not a broken img)', () => {
    renderGrid([summary({ coverImageUrl: '' })]);
    expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders an <img> when a coverImageUrl is present', () => {
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/x.jpg' })]);
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://cdn.example/x.jpg');
    expect(screen.queryByTestId('cover-placeholder')).toBeNull();
  });

  it('falls back to the placeholder when the cover image fails to load (broken URL)', () => {
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/broken.jpg' })]);
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    // Simulate the browser firing onError for a broken/expired image URL.
    fireEvent.error(img as HTMLImageElement);
    expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
