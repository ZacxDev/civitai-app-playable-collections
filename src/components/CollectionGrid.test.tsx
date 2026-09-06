import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CollectionGrid, RecentRail } from './CollectionGrid.js';
import { palette } from '../theme.js';
import type { CollectionSummary } from '../types.js';
import { flushIntersections } from '../test-setup.js';

const c = palette();

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

describe('an empty collection is not playable — this app is a player', () => {
  // 🔴 MEASURED LIVE 2026-09-05: "Bookmarked Articles · 0 items" rendered an
  // ordinary play affordance on the My-collections tab. Pressing it plays
  // nothing, so the one thing the app exists to do silently does nothing — the
  // failure mode is indistinguishable from the app being broken.
  //
  // 🔴 THIS TEST EXISTS BECAUSE A MUTANT SURVIVED. The guard shipped first with
  // no coverage at all: flipping `disabled` to `false` left the whole suite green
  // at 376/376. An unguarded fix is one line from being reverted by the next
  // person who tidies the JSX.

  it('disables the card and says why, instead of promising a play', () => {
    renderGrid([summary({ id: 7, name: 'Bookmarked Articles', itemCount: 0 })]);
    const card = screen.getByTestId('collection-card');
    expect(card).toBeDisabled();
    // The label states the reason rather than the (absent) item count.
    expect(card).toHaveAttribute('aria-label', 'Bookmarked Articles — nothing to play yet');
    expect(card.getAttribute('aria-label')).not.toMatch(/^Play /);
  });

  it('does NOT fire onOpen when an empty card is clicked', () => {
    // 🔴 The BEHAVIOURAL half. `disabled` is an attribute; this asserts the
    // consequence, because a card could carry the attribute and still be wired
    // to something that fires (a wrapping handler, a keydown path).
    const onOpen = vi.fn();
    render(
      <CollectionGrid
        collections={[summary({ id: 7, name: 'Bookmarked Articles', itemCount: 0 })]}
        loading={false}
        error={null}
        emptyLabel="empty"
        onOpen={onOpen}
        c={c}
        isMobile={false}
      />,
    );
    fireEvent.click(screen.getByTestId('collection-card'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('leaves a NON-empty collection alone — enabled, and still labelled "Play …"', () => {
    // The control arm. Without it, `disabled` hardcoded to TRUE would pass every
    // assertion above and break every collection in the app.
    renderGrid([summary({ id: 8, name: 'Neon Cities', itemCount: 3 })]);
    const card = screen.getByTestId('collection-card');
    expect(card).not.toBeDisabled();
    expect(card).toHaveAttribute('aria-label', 'Play Neon Cities — 3 items');
  });
});

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

  it('lazy-loads the cover: data-src until near the viewport, then swaps to src (feedback #1b)', () => {
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/x.jpg' })]);
    const img = document.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    // Deferred: the URL is parked on data-src, the <img> has not fetched yet.
    expect(img.getAttribute('data-src')).toBe('https://cdn.example/x.jpg');
    expect(img.getAttribute('src')).toBeNull();
    // The grid observer reports the cover entering the viewport → swap in.
    flushIntersections(true);
    expect(img.getAttribute('src')).toBe('https://cdn.example/x.jpg');
    expect(img.getAttribute('data-src')).toBeNull();
    expect(screen.queryByTestId('cover-placeholder')).toBeNull();
  });

  it('falls back to the placeholder when the cover image fails to load (broken URL)', () => {
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/broken.jpg' })]);
    flushIntersections(true); // swap data-src → src
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    // Simulate the browser firing onError for a broken/expired image URL.
    fireEvent.error(img as HTMLImageElement);
    expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('CoverImage distinguishes an ABSENT level from a level of ZERO', () => {
  // 🔴 MEASURED LIVE 2026-09-05 against production: `GET /api/v1/blocks/collections`
  // does NOT return `coverNsfwLevel` at all — the response item keys are exactly
  // [coverImageUrl, curator, description, followed, id, isPublic, itemCount, name].
  // So `CollectionSummary.coverNsfwLevel` is ALWAYS `undefined`, the old
  // `nsfwLevel ?? 0` collapsed that to 0 → 'unknown' → shouldBlur(0) === true, and
  // 100% of cards on the discover grid rendered blurred and badged "Unrated".
  //
  // The gate is NOT deleted — it is made to tell the two cases apart, so it keeps
  // working once the upstream field ships. These four tests pin BOTH halves: the
  // absent case (open) and the supplied cases (unchanged, including a real 0).

  it('an ABSENT coverNsfwLevel renders the cover UNGATED — no blur, no badge', () => {
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/x.jpg', coverNsfwLevel: undefined })]);
    expect(screen.queryByTestId('cover-gate')).toBeNull();
    expect(screen.queryByTestId('maturity-badge')).toBeNull();
    expect(screen.queryByTestId('cover-reveal')).toBeNull();
    // The <img> itself carries no blur filter.
    expect(document.querySelector('img')).not.toHaveStyle({ filter: 'blur(36px)' });
  });

  it('a SUPPLIED R level (4) still blurs and still badges — the gate is intact', () => {
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/x.jpg', coverNsfwLevel: 4 })]);
    expect(screen.getByTestId('cover-gate')).toHaveAttribute('data-revealed', 'false');
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('R');
    expect(document.querySelector('img')).toHaveStyle({ filter: 'blur(36px)' });
  });

  it('🔴 an EXPLICIT ZERO still blurs — fail-closed is preserved for a real unrated level', () => {
    // The discriminating case. A guard written as `nsfwLevel ?? 0` cannot see the
    // difference between this row and the one above it; a guard written as
    // `!nsfwLevel` would wrongly open this one too.
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/x.jpg', coverNsfwLevel: 0 })]);
    expect(screen.getByTestId('cover-gate')).toBeInTheDocument();
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('Unrated');
    expect(document.querySelector('img')).toHaveStyle({ filter: 'blur(36px)' });
  });

  it('a SUPPLIED PG level (1) is ungated, as it always was', () => {
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/x.jpg', coverNsfwLevel: 1 })]);
    expect(screen.queryByTestId('cover-gate')).toBeNull();
    expect(screen.queryByTestId('maturity-badge')).toBeNull();
  });

  it('the fix lives in CoverImage, so the RAILS get it too (not just the grid)', () => {
    // CoverImage has three call sites (grid card, popular rail, recent rail). This
    // pins that the change was made in the component rather than at one call site
    // — a per-call-site fix would leave this rail blurring every cover.
    render(
      <RecentRail
        entries={[{ id: 3, name: 'Continue', coverImageUrl: 'https://cdn.example/r.jpg', coverNsfwLevel: undefined }]}
        onOpen={vi.fn()}
        c={c}
      />,
    );
    expect(screen.getByTestId('recent-card')).toBeInTheDocument();
    expect(screen.queryByTestId('cover-gate')).toBeNull();
    expect(screen.queryByTestId('maturity-badge')).toBeNull();
  });
});
