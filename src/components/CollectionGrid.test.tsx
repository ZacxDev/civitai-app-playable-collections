import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Harness } from '@civitai/blocks-react/testing';
import { BrowsingLevel, SFW_LEVELS } from '@civitai/app-sdk/blocks';

import { CollectionGrid, PopularRail, RecentRail } from './CollectionGrid.js';
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

  // 🔴 THESE TWO FIXTURES GAINED `coverNsfwLevel`, AND THAT IS A REAL BEHAVIOUR
  // CHANGE, NOT A TEST TWEAK. A cover whose rating the server never stated is no
  // longer painted (see the maturity suite below), so a lazy-load / broken-URL
  // test needs a cover the ceiling actually permits or it has no <img> to assert
  // on. The absent-level case is now covered explicitly, as a placeholder.
  it('lazy-loads the cover: data-src until near the viewport, then swaps to src (feedback #1b)', () => {
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/x.jpg', coverNsfwLevel: BrowsingLevel.PG })]);
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
    renderGrid([summary({ coverImageUrl: 'https://cdn.example/broken.jpg', coverNsfwLevel: BrowsingLevel.PG })]);
    flushIntersections(true); // swap data-src → src
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    // Simulate the browser firing onError for a broken/expired image URL.
    fireEvent.error(img as HTMLImageElement);
    expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cover maturity — the host ceiling decides, and there is no reveal
// ---------------------------------------------------------------------------
// 🔴 WHAT THESE TESTS REPLACE. Two suites lived here: one pinning that an ABSENT
// `coverNsfwLevel` rendered OPEN while a supplied `0` rendered BLURRED, and one
// scoping that fail-open to a SFW domain ceiling. Both described a per-cover
// tap-to-reveal (`cover-gate` / `cover-reveal`) that carried NO age assertion at
// all — a blur you could click away. That mechanism is deleted.
//
// The rule now: a cover is painted iff the viewer's ceiling permits its rating.
// An over-ceiling (or unstated) rating falls into the SAME ▶ placeholder tile a
// missing cover already used — the card, its title, its curator and its play
// affordance all survive, because the ceiling excluded ONE IMAGE, not the
// collection. Nothing anywhere reveals it.
//
// 🔴 WHY AN ABSENT LEVEL IS NOW REFUSED RATHER THAN OPENED. The server publishes
// the level OF THE IMAGE IT SERVED (`toCoverFields`) and omits the field exactly
// when `coverImageUrl` is null (civitai #4663). So against a current host absent
// arrives with no `src` and the placeholder branch has already fired — refusing
// it changes nothing there, and against an older host it degrades a cover to the
// placeholder instead of painting an image whose rating nobody stated.

const CEILING_UP_TO_R = SFW_LEVELS | BrowsingLevel.R;
const CEILING_ALL = SFW_LEVELS | BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX;

const coverAt = (over: Partial<CollectionSummary> = {}) =>
  summary({ coverImageUrl: 'https://cdn.example/x.jpg', ...over });

/** Render the grid inside a host projecting an explicit ceiling BITMASK.
 *  `undefined` → a host that emits NO `maxBrowsingLevel` (predates civitai #2670). */
function renderAtCeiling(ceiling: number | undefined, collections: CollectionSummary[]) {
  return render(
    <Harness showLog={false} {...(ceiling === undefined ? {} : { maxBrowsingLevel: ceiling })}>
      <CollectionGrid
        collections={collections}
        loading={false}
        error={null}
        emptyLabel="empty"
        onOpen={vi.fn()}
        c={c}
        isMobile={false}
      />
    </Harness>,
  );
}

describe('CoverImage — a cover is painted only if the ceiling permits its rating', () => {
  it('a PG cover under a SFW ceiling is painted, with no badge', async () => {
    renderAtCeiling(SFW_LEVELS, [coverAt({ coverNsfwLevel: BrowsingLevel.PG })]);
    await waitFor(() => expect(screen.getByTestId('collection-card')).toBeInTheDocument());
    expect(document.querySelector('img')).not.toBeNull();
    expect(screen.queryByTestId('cover-placeholder')).toBeNull();
    expect(screen.queryByTestId('maturity-badge')).toBeNull();
  });

  it('a PG-13 cover under a SFW ceiling is painted WITH its badge (label, not gate)', async () => {
    renderAtCeiling(SFW_LEVELS, [coverAt({ coverNsfwLevel: BrowsingLevel.PG13 })]);
    await waitFor(() => expect(screen.getByTestId('cover-badged')).toBeInTheDocument());
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('PG-13');
    expect(document.querySelector('img')).not.toBeNull();
    expect(document.querySelector('img')).not.toHaveStyle({ filter: 'blur(36px)' });
  });

  it('🔴 an ABOVE-ceiling cover is NOT PAINTED — placeholder tile, no <img>, no reveal', async () => {
    renderAtCeiling(SFW_LEVELS, [coverAt({ coverNsfwLevel: BrowsingLevel.R })]);
    await waitFor(() => expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument());
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByTestId('cover-reveal')).toBeNull();
    expect(screen.queryByTestId('cover-gate')).toBeNull();
    expect(screen.queryByTestId('maturity-badge')).toBeNull();
  });

  it('🔴 the CARD survives an excluded cover — the ceiling excluded one image, not the collection', async () => {
    // Omitting the whole row would change the grid length, the infinite-scroll
    // page arithmetic and the "N items" the card promises, all for a thumbnail.
    const onOpen = vi.fn();
    render(
      <Harness showLog={false} maxBrowsingLevel={SFW_LEVELS}>
        <CollectionGrid
          collections={[coverAt({ id: 9, name: 'Neon Cities', itemCount: 3, coverNsfwLevel: BrowsingLevel.XXX })]}
          loading={false}
          error={null}
          emptyLabel="empty"
          onOpen={onOpen}
          c={c}
          isMobile={false}
        />
      </Harness>,
    );
    await waitFor(() => expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument());
    const card = screen.getByTestId('collection-card');
    expect(card).toHaveAttribute('aria-label', 'Play Neon Cities — 3 items');
    expect(card).not.toBeDisabled();
    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalled();
  });

  // ---- the ceiling and the level disagree, in BOTH directions --------------

  it('🔴 SAME R cover, an ALL-LEVELS ceiling → it IS painted, badged R', async () => {
    // The discriminator. A mutant that ignored the ceiling and reused the old
    // "R and up is hidden" rule passes every test above and fails only here.
    renderAtCeiling(CEILING_ALL, [coverAt({ coverNsfwLevel: BrowsingLevel.R })]);
    await waitFor(() => expect(screen.getByTestId('maturity-badge')).toHaveTextContent('R'));
    expect(document.querySelector('img')).not.toBeNull();
    expect(screen.queryByTestId('cover-placeholder')).toBeNull();
  });

  it('🔴 SAME up-to-R ceiling, two different levels → R is painted, X is not', async () => {
    renderAtCeiling(CEILING_UP_TO_R, [
      coverAt({ id: 1, coverNsfwLevel: BrowsingLevel.R }),
      coverAt({ id: 2, coverNsfwLevel: BrowsingLevel.X }),
    ]);
    await waitFor(() => expect(screen.getAllByTestId('collection-card')).toHaveLength(2));
    expect(screen.getAllByTestId('maturity-badge')).toHaveLength(1);
    expect(screen.getAllByTestId('maturity-badge')[0]).toHaveTextContent('R');
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(screen.getAllByTestId('cover-placeholder')).toHaveLength(1);
  });

  // ---- fail-closed: four kinds of "we do not know" -------------------------

  it('🔴 FAIL CLOSED — before BLOCK_INIT (no host at all): an R cover is not painted', () => {
    // No <Harness>, so the ceiling reads `undefined`. Asserted synchronously: the
    // FIRST paint must already be SFW-only, not "SFW once init lands".
    renderGrid([coverAt({ coverNsfwLevel: BrowsingLevel.R })]);
    expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('🔴 FAIL CLOSED — a host that OMITS maxBrowsingLevel: R out, PG in', async () => {
    renderAtCeiling(undefined, [
      coverAt({ id: 1, coverNsfwLevel: BrowsingLevel.R }),
      coverAt({ id: 2, coverNsfwLevel: BrowsingLevel.PG }),
    ]);
    // The PG cover is the positive control: it proves the host mounted and the
    // grid rendered, so "the R cover is absent" is not vacuous.
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(1));
    expect(screen.getAllByTestId('cover-placeholder')).toHaveLength(1);
  });

  // ---- the THREE cover states, and why none may be collapsed into another ----
  // 🔴 `toCoverFields` OMITS `coverNsfwLevel` when there is no cover, and publishes
  // `0` for an UNRATED cover (<civitai>@origin/release:146-150). So absent and 0
  // are different facts arriving on the same key, and this app has already shipped
  // a bug in each direction: `nsfwLevel ?? 0` blurred every card, and a later fix
  // hid every unrated one. These three tests are what make the states distinct by
  // TEST rather than by comment — each fails if any pair is re-merged.

  it('🔴 an UNRATED (0) cover is PAINTED, on a SFW ceiling, badged "Unrated"', async () => {
    // 🔴 REVERSED from "an UNRATED (0) cover is refused even on an all-levels
    // ceiling". Refusing it was the app overriding the server, which permits
    // unrated everywhere (block-collections.service.ts:193, :359).
    renderAtCeiling(SFW_LEVELS, [coverAt({ coverNsfwLevel: 0 })]);
    await waitFor(() => expect(screen.getByTestId('cover-badged')).toBeInTheDocument());
    expect(document.querySelector('img')).not.toBeNull();
    expect(screen.queryByTestId('cover-placeholder')).toBeNull();
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('Unrated');
  });

  it('🔴 FAIL CLOSED — an ABSENT coverNsfwLevel is refused on EVERY ceiling', async () => {
    // Unknowable, NOT unrated. Against a #4663 host this state implies
    // `coverImageUrl === null` (the two fields travel together), which the `!src`
    // branch already handles; this pins the OLDER-host path, where a `src` arrives
    // with no level at all.
    renderAtCeiling(CEILING_ALL, [coverAt({ coverNsfwLevel: undefined })]);
    await waitFor(() => expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument());
    expect(document.querySelector('img')).toBeNull();
  });

  it('🔴 THE PAIR, SIDE BY SIDE: an unrated cover paints while an absent-level cover does not', async () => {
    // The anti-merge witness at the surface. One grid, one ceiling, two rows that
    // differ ONLY in absent-vs-0 — so any collapse in either direction changes the
    // image count and fails here, which neither single-row test above can promise.
    renderAtCeiling(SFW_LEVELS, [
      coverAt({ id: 1, coverNsfwLevel: 0 }),
      coverAt({ id: 2, coverNsfwLevel: undefined }),
    ]);
    await waitFor(() => expect(screen.getAllByTestId('collection-card')).toHaveLength(2));
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(screen.getAllByTestId('cover-placeholder')).toHaveLength(1);
    expect(screen.getAllByTestId('maturity-badge')).toHaveLength(1);
    expect(screen.getAllByTestId('maturity-badge')[0]).toHaveTextContent('Unrated');
  });

  it('the rule lives in CoverImage, so the RAILS inherit it — a call site cannot forget', async () => {
    // CoverImage has three call sites (grid card, popular rail, recent rail).
    render(
      <Harness showLog={false} maxBrowsingLevel={SFW_LEVELS}>
        <RecentRail
          entries={[
            { id: 3, name: 'Continue', coverImageUrl: 'https://cdn.example/r.jpg', coverNsfwLevel: BrowsingLevel.X },
            { id: 4, name: 'Keep going', coverImageUrl: 'https://cdn.example/s.jpg', coverNsfwLevel: BrowsingLevel.PG },
          ]}
          onOpen={vi.fn()}
          c={c}
        />
      </Harness>,
    );
    await waitFor(() => expect(screen.getAllByTestId('recent-card')).toHaveLength(2));
    // The X entry is a placeholder; the PG entry paints. Both cards remain.
    expect(screen.getAllByTestId('cover-placeholder')).toHaveLength(1);
    expect(document.querySelectorAll('img')).toHaveLength(1);
  });
});

describe('the end of the list is a place, not an absence', () => {
  // 🔴 The grid used to render NOTHING once `hasMore` went false, and that was
  // survivable only because the end was unreachable: the unwindowed popular feed
  // pages the whole corpus. The Month default is ClickHouse-ranked and bounded —
  // ~446 Image collections, ~18 pages at limit 24 — so the end is somewhere real
  // viewers now arrive, and a grid that simply stops mid-scroll is
  // indistinguishable from a broken loader.

  const gridWith = (props: Partial<Parameters<typeof CollectionGrid>[0]>) =>
    render(
      <CollectionGrid
        collections={[summary({ id: 1 }), summary({ id: 2 })]}
        loading={false}
        error={null}
        emptyLabel="empty"
        onOpen={vi.fn()}
        c={c}
        isMobile={false}
        {...props}
      />,
    );

  it('shows the end label once there are no more pages', () => {
    gridWith({ hasMore: false, loadingMore: false, endLabel: 'No more for this window.' });
    expect(screen.getByTestId('grid-end')).toHaveTextContent('No more for this window.');
  });

  it('does NOT claim the end while another page is still coming', () => {
    gridWith({ hasMore: true, loadingMore: false, endLabel: 'No more for this window.' });
    expect(screen.queryByTestId('grid-end')).toBeNull();
  });

  it('does NOT claim the end while a page is in flight', () => {
    gridWith({ hasMore: false, loadingMore: true, endLabel: 'No more for this window.' });
    expect(screen.queryByTestId('grid-end')).toBeNull();
  });

  it('stays silent for a caller that asks for no marker', () => {
    // The `mine` tab: a short, unpaginated list whose end has always been
    // obvious. Leaving `endLabel` undefined keeps that surface as it was.
    gridWith({ hasMore: false, loadingMore: false });
    expect(screen.queryByTestId('grid-end')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PHASE 3 — the follow control on cards. The control is upstream
// `FollowButton` (the viewer's own), so these tests pin the CARD-side
// properties, not the button's internals: presence/supersession, the sibling
// relationship to the open button, and the commit wiring.
// ---------------------------------------------------------------------------

describe('follow control on cards (Phase 3)', () => {
  function renderFollowGrid(collections: CollectionSummary[]) {
    const onFollowChange = vi.fn<(collectionId: number, followed: boolean) => void>();
    const onOpen = vi.fn<(collection: CollectionSummary) => void>();
    render(
      <Harness viewer={{ id: 99, username: 'me' }} theme="dark" showLog={false}>
        <CollectionGrid
          collections={collections}
          loading={false}
          error={null}
          emptyLabel="empty"
          onOpen={onOpen}
          onFollowChange={onFollowChange}
          c={c}
          isMobile={false}
        />
      </Harness>,
    );
    return { onFollowChange, onOpen };
  }

  it('renders the control INSTEAD OF the followed badge when follow is wired', () => {
    renderFollowGrid([summary({ id: 1, followed: true }), summary({ id: 2, followed: false })]);
    const controls = screen.getAllByTestId('card-follow');
    expect(controls).toHaveLength(2);
    // The control shows the state itself — pressed + "Following" — so the
    // badge it supersedes must not ALSO render (same fact, twice, same corner).
    expect(controls[0]).toHaveAttribute('aria-pressed', 'true');
    expect(controls[0]).toHaveTextContent('Following');
    expect(controls[1]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('followed-badge')).toBeNull();
  });

  it('keeps the Private badge alongside the control', () => {
    renderFollowGrid([summary({ id: 1, isPublic: false, followed: false })]);
    expect(screen.getByTestId('private-badge')).toBeInTheDocument();
    expect(screen.getByTestId('card-follow')).toBeInTheDocument();
  });

  it('without a follow handler the badge remains the indicator and no control renders', () => {
    // The no-wiring render (component isolation): nothing to commit through,
    // so the card falls back to the read-only ★ and no dead control appears.
    renderGrid([summary({ id: 1, followed: true })]);
    expect(screen.getByTestId('followed-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('card-follow')).toBeNull();
  });

  it('clicking the control commits through onFollowChange and does NOT open the collection', async () => {
    const { onFollowChange, onOpen } = renderFollowGrid([summary({ id: 7, followed: false })]);
    await userEvent.click(screen.getByTestId('card-follow'));
    // The host echo is adopted by the control itself…
    await waitFor(() => expect(screen.getByTestId('card-follow')).toHaveAttribute('aria-pressed', 'true'));
    // …and reported through the app's one handler, bound to THIS card's id.
    expect(onFollowChange).toHaveBeenCalledTimes(1);
    expect(onFollowChange).toHaveBeenCalledWith(7, true);
    // 🔴 The sibling property: the click followed, it did not open. (A
    // control nested inside the card's <button> would bubble into onOpen.)
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("an EMPTY card's open button is disabled but its follow control is not", async () => {
    // Playing an empty collection is impossible; following one is not. The
    // sibling structure is what makes the second half of that sentence true.
    const { onFollowChange } = renderFollowGrid([summary({ id: 8, itemCount: 0, followed: false })]);
    expect(screen.getByTestId('collection-card')).toBeDisabled();
    const control = screen.getByTestId('card-follow');
    expect(control).not.toBeDisabled();
    await userEvent.click(control);
    await waitFor(() => expect(onFollowChange).toHaveBeenCalledWith(8, true));
  });
});

describe('follow control on the Popular rail (Phase 3)', () => {
  const entries = (followedId?: number) =>
    [11, 12, 13].map((id, i) => ({
      collection: summary({ id, name: `Popular ${id}`, followed: id === followedId }),
      count: 5 - i,
    }));

  function renderRail(followedId?: number) {
    const onFollowChange = vi.fn<(collectionId: number, followed: boolean) => void>();
    const onOpen = vi.fn<(collection: CollectionSummary) => void>();
    render(
      <Harness viewer={{ id: 99, username: 'me' }} theme="dark" showLog={false}>
        <PopularRail entries={entries(followedId)} onOpen={onOpen} onFollowChange={onFollowChange} c={c} />
      </Harness>,
    );
    return { onFollowChange, onOpen };
  }

  it('renders one control per rail card, pressed state from the entry', () => {
    renderRail(12);
    const controls = screen.getAllByTestId('popular-follow');
    expect(controls).toHaveLength(3);
    expect(controls.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });

  it('clicking a rail control commits for that collection and does NOT open it', async () => {
    const { onFollowChange, onOpen } = renderRail();
    await userEvent.click(screen.getAllByTestId('popular-follow')[2]);
    await waitFor(() => expect(onFollowChange).toHaveBeenCalledWith(13, true));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('the rail open button still opens', async () => {
    const { onOpen } = renderRail();
    await userEvent.click(screen.getAllByTestId('popular-card')[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ id: 11 });
  });
});
