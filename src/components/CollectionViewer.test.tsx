import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { BrowsingLevel, SFW_LEVELS } from '@civitai/app-sdk/blocks';

import { CollectionViewer } from './CollectionViewer.js';
import { palette } from '../theme.js';
import { loadCollectionState } from '../view-modes.js';
import type { CollectionDetail, MediaItem } from '../types.js';

const c = palette();

function img(id: number): MediaItem {
  return { mediaId: id, type: 'image', url: `https://x.invalid/i/${id}.jpg`, width: 100, height: 100, creator: { userId: 1, username: 'alice' }, nsfwLevel: 1 };
}
function vid(id: number): MediaItem {
  return { mediaId: id, type: 'video', url: `https://x.invalid/v/${id}.mp4`, width: 100, height: 100, creator: { userId: 1, username: 'alice' }, nsfwLevel: 1 };
}
const detail = (id = 101): CollectionDetail => ({
  id,
  name: 'Neon',
  description: null,
  curator: { userId: 5, username: 'cur' },
  isPublic: true,
  followed: false,
});

/** Fresh in-memory Storage so persistence tests are isolated. */
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

function renderViewer(over: Partial<React.ComponentProps<typeof CollectionViewer>> = {}) {
  const props: React.ComponentProps<typeof CollectionViewer> = {
    detail: detail(),
    items: [vid(1), img(2), img(3), vid(4)],
    settings: { secondsPerImage: 5, videoLoopCount: 1 },
    onSecondsPerImageChange: () => {},
    onVideoLoopCountChange: () => {},
    viewerUserId: 99,
    buzzBalance: 1000,
    followed: false,
    onFollowChange: () => {},
    onNotice: () => {},
    onFollowUncertain: () => {},
    onTip: async () => true,
    tipping: false,
    splitPlans: {},
    onSplitPlanChange: () => {},
    isMobile: false,
    c,
    onExit: () => {},
    storage: memStorage(),
    reducedMotion: true,
    ...over,
  };
  return render(<CollectionViewer {...props} />);
}

function mature(id: number, nsfwLevel = 4): MediaItem {
  return { ...img(id), nsfwLevel };
}

describe('CollectionViewer — onboarding coach (Feature #10)', () => {
  it('shows the coach on first open and hides it (persisted) after dismiss', async () => {
    const storage = memStorage();
    const { unmount } = renderViewer({ storage });
    expect(screen.getByTestId('onboarding-coach')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('onboarding-dismiss'));
    expect(screen.queryByTestId('onboarding-coach')).toBeNull();
    unmount();

    // Reopen with the SAME storage → the coach does not return.
    renderViewer({ storage });
    expect(screen.queryByTestId('onboarding-coach')).toBeNull();
  });
});

describe('CollectionViewer — cast / ambient mode (Feature #8)', () => {
  it('toggling cast hides the chrome, marks the surface, and offers an exit', async () => {
    renderViewer({ items: [img(1), img(2), img(3)] });
    const cv = screen.getByTestId('collection-viewer');
    expect(cv).toHaveAttribute('data-cast', 'off');
    expect(screen.getByTestId('viewer-exit')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('cast-toggle'));
    expect(screen.getByTestId('collection-viewer')).toHaveAttribute('data-cast', 'on');
    // Chrome (toolbar) is gone; the player is marked cast; an exit affordance shows.
    expect(screen.queryByTestId('viewer-exit')).toBeNull();
    expect(screen.queryByTestId('mode-switcher')).toBeNull();
    expect(screen.getByTestId('player')).toHaveAttribute('data-cast', 'on');
    expect(screen.getByTestId('cast-exit')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('cast-exit'));
    expect(screen.getByTestId('collection-viewer')).toHaveAttribute('data-cast', 'off');
    expect(screen.getByTestId('viewer-exit')).toBeInTheDocument();
  });

  it('reports cast enter/exit via onCast (analytics)', async () => {
    const onCast = vi.fn();
    renderViewer({ items: [img(1)], onCast });
    await userEvent.click(screen.getByTestId('cast-toggle'));
    expect(onCast).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByTestId('cast-exit'));
    expect(onCast).toHaveBeenLastCalledWith(false);
  });

  // In cast mode the transport chrome (incl. progress-label) is hidden, so we
  // observe advancement via the current media element's src.
  it('cast auto-advances the slideshow when motion is allowed', () => {
    vi.useFakeTimers();
    try {
      renderViewer({ items: [img(1), img(2), img(3)], reducedMotion: false, settings: { secondsPerImage: 2, videoLoopCount: 1 } });
      fireEvent.click(screen.getByTestId('cast-toggle'));
      expect(screen.getByTestId('media-image').getAttribute('src')).toContain('/1.jpg');
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByTestId('media-image').getAttribute('src')).toContain('/2.jpg');
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects reduced motion in cast — does NOT auto-advance', () => {
    vi.useFakeTimers();
    try {
      renderViewer({ items: [img(1), img(2)], reducedMotion: true, settings: { secondsPerImage: 1, videoLoopCount: 1 } });
      fireEvent.click(screen.getByTestId('cast-toggle'));
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByTestId('media-image').getAttribute('src')).toContain('/1.jpg');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Player — global shortcuts ignored while a control is focused (ship-blocker #4)', () => {
  it('ArrowRight on the focused scrubber does NOT also advance the player (no double-fire)', async () => {
    renderViewer({ items: [img(1), img(2), img(3), img(4)] });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 4');
    // Focus the scrubber (a range input) and press ArrowRight — the global player
    // keydown must ignore it so the position does not jump.
    const scrubber = screen.getByTestId('scrubber');
    scrubber.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 4');

    // With focus off any control, ArrowRight DOES advance (shortcut still works).
    scrubber.blur();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 4');
  });
});

// ---------------------------------------------------------------------------
// Content maturity — rendered from the PLATFORM's ceiling, with no app-local gate
// ---------------------------------------------------------------------------
// 🔴 WHAT THIS SUITE REPLACED, AND WHY THOSE TESTS ARE GONE RATHER THAN FIXED.
// It used to pin a session-level "I'm 18+" acknowledgement: an R item rendered
// blurred behind a `maturity-reveal` overlay, one click unblurred the whole
// playthrough, and the tests asserted the blur, the overlay, the once-per-session
// semantics and the cast-mode suppression. Every one of those was a test OF THE
// APP'S OWN CONSENT MECHANISM, which no longer exists — maturity is the viewer's
// NSFW browsing level, set in the civitai site header and enforced by the host,
// and the app must not re-ask it. Content above the ceiling is NOT RENDERED, so
// there is nothing to blur and nothing to reveal.
//
// What survives in spirit is the fail-closed posture, which is now asserted
// against a wider set of unknowns than before (pre-`BLOCK_INIT`, a host that
// omits the field, an unrated level, an anonymous viewer).

/** The three ceilings the fixtures below use, spelled from the SDK's own bits. */
const CEILING_UP_TO_R = SFW_LEVELS | BrowsingLevel.R;
const CEILING_ALL = SFW_LEVELS | BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX;

/**
 * Render the viewer inside a host projecting an explicit ceiling BITMASK.
 * `ceiling: undefined` installs a host that emits NO `maxBrowsingLevel` at all —
 * the civitai-#2670-predating case, which must behave as SFW-only.
 */
function renderAtCeiling(
  ceiling: number | undefined,
  over: Partial<React.ComponentProps<typeof CollectionViewer>> = {},
  harnessOver: { viewer?: { id: number; username: string } | null } = {},
) {
  const props: React.ComponentProps<typeof CollectionViewer> = {
    detail: detail(),
    items: [img(1)],
    settings: { secondsPerImage: 5, videoLoopCount: 1 },
    onSecondsPerImageChange: () => {},
    onVideoLoopCountChange: () => {},
    viewerUserId: 99,
    buzzBalance: 1000,
    followed: false,
    onFollowChange: () => {},
    onNotice: () => {},
    onFollowUncertain: () => {},
    onTip: async () => true,
    tipping: false,
    splitPlans: {},
    onSplitPlanChange: () => {},
    isMobile: false,
    c,
    onExit: () => {},
    storage: memStorage(),
    reducedMotion: true,
    ...over,
  };
  return render(
    <Harness showLog={false} {...(ceiling === undefined ? {} : { maxBrowsingLevel: ceiling })} {...harnessOver}>
      <CollectionViewer {...props} />
    </Harness>,
  );
}

/** Wait for the projected ceiling to land (BLOCK_INIT is asynchronous). */
async function settled() {
  await waitFor(() => expect(screen.getByTestId('collection-viewer')).toBeInTheDocument());
}

describe('CollectionViewer — the classic Player renders from the host ceiling', () => {
  it('a PG item within the ceiling renders, unblurred and unbadged', async () => {
    renderAtCeiling(SFW_LEVELS, { items: [img(1)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('media-image')).toBeInTheDocument());
    expect(screen.queryByTestId('maturity-badge')).toBeNull();
    expect(screen.getByTestId('media-image')).not.toHaveStyle({ filter: 'blur(36px)' });
  });

  it('a PG-13 item within the ceiling renders WITH its badge — a badge is a label, not a gate', async () => {
    renderAtCeiling(SFW_LEVELS, { items: [mature(1, BrowsingLevel.PG13)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('maturity-badge')).toHaveTextContent('PG-13'));
    expect(screen.getByTestId('media-image')).toBeInTheDocument();
    expect(screen.getByTestId('media-image')).not.toHaveStyle({ filter: 'blur(36px)' });
  });

  it('🔴 an ABOVE-ceiling item is NOT RENDERED AT ALL — not blurred, not badged, not counted', async () => {
    renderAtCeiling(SFW_LEVELS, { items: [mature(1, BrowsingLevel.R), img(2)] });
    await settled();
    // The R item is absent from the list, so the player is a ONE-item player and
    // its progress readout says so. That is the load-bearing half: a blurred item
    // would still be "1 / 2".
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 1'));
    expect(screen.queryByTestId('maturity-badge')).toBeNull();
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', img(2).url);
  });

  it('🔴 every item above the ceiling → the player reports no playable media (no empty blurred stage)', async () => {
    renderAtCeiling(SFW_LEVELS, { items: [mature(1, BrowsingLevel.X), mature(2, BrowsingLevel.XXX)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('player-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('media-image')).toBeNull();
  });

  // ---- the ceiling and the item DISAGREE, in BOTH directions ----------------
  // 🔴 WITHOUT THESE THE SUITE CANNOT TELL WHAT THE GUARD IS KEYED ON. Every
  // assertion above uses a ceiling and an item that agree about the verdict, so a
  // mutant that ignored the ceiling and hardcoded "R and up is hidden" (the OLD
  // `shouldBlur` rule) would satisfy all of them. The next two hold one side
  // constant and move the other.

  it('🔴 SAME R item, WIDER ceiling → it RENDERS (the guard reads the ceiling, not a hardcoded PG-13 line)', async () => {
    renderAtCeiling(CEILING_ALL, { items: [mature(1, BrowsingLevel.R), img(2)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('maturity-badge')).toHaveTextContent('R'));
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', mature(1, BrowsingLevel.R).url);
  });

  it('🔴 SAME up-to-R ceiling, HIGHER item → R renders and X does not (the guard reads the item, not just the ceiling)', async () => {
    renderAtCeiling(CEILING_UP_TO_R, { items: [mature(1, BrowsingLevel.R), mature(2, BrowsingLevel.X)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('maturity-badge')).toHaveTextContent('R'));
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 1');
  });

  // ---- fail-closed: four kinds of "we do not know" -------------------------

  it('🔴 FAIL CLOSED — before BLOCK_INIT (no host at all): an R item is not rendered', () => {
    // Rendered with NO <Harness>, so no BLOCK_INIT is ever delivered and the
    // ceiling reads `undefined`. Asserted synchronously, which is the point: the
    // very first paint must already be SFW-only.
    renderViewer({ items: [mature(1, BrowsingLevel.R), img(2)] });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 1');
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', img(2).url);
  });

  it('🔴 FAIL CLOSED — a host that OMITS maxBrowsingLevel (predates civitai #2670): SFW only', async () => {
    renderAtCeiling(undefined, { items: [mature(1, BrowsingLevel.R), img(2)] });
    await settled();
    // Positive control that the host really did mount and init: the PG item is
    // there. If nothing rendered, "the R item is absent" would be vacuous.
    await waitFor(() => expect(screen.getByTestId('media-image')).toHaveAttribute('src', img(2).url));
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 1');
  });

  it('🔴 an UNRATED (0) item RENDERS, on a SFW ceiling, badged "Unrated"', async () => {
    // 🔴 REVERSED FROM ITS FIRST VERSION, WHICH ASSERTED THE OPPOSITE. That test
    // pinned "an unrated item is refused even on an all-levels ceiling" and called
    // it the safe direction. It was not safe, it was the app OVERRIDING the
    // server, which permits unrated at every ceiling
    // (<civitai>@origin/release block-collections.service.ts:193, :359) — and it
    // was worse than the blur it replaced, because a blurred item was at least
    // reachable. A 0 is a rating the server assigned; refusing it is not caution.
    renderAtCeiling(SFW_LEVELS, { items: [mature(1, 0), img(2)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2'));
    expect(screen.getByTestId('media-image')).toHaveAttribute('src', mature(1, 0).url);
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('Unrated');
  });

  it('🔴 an unrated (0) item renders on an ALL-LEVELS ceiling too — the level, not the ceiling, decides it', async () => {
    renderAtCeiling(CEILING_ALL, { items: [mature(1, 0), img(2)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2'));
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('Unrated');
  });

  it('🔴 FAIL CLOSED — an ANONYMOUS viewer on a host that projects no ceiling: SFW only', async () => {
    renderAtCeiling(
      undefined,
      { items: [mature(1, BrowsingLevel.X), img(2)], viewerUserId: null },
      { viewer: null },
    );
    await settled();
    await waitFor(() => expect(screen.getByTestId('media-image')).toHaveAttribute('src', img(2).url));
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 1');
  });
});

describe('CollectionViewer — the continuous surfaces and the lightbox agree with the player', () => {
  it('🔴 an above-ceiling tile is ABSENT from the wall, so there is no tile to tap', async () => {
    renderAtCeiling(SFW_LEVELS, { items: [mature(1, BrowsingLevel.X), img(2), img(3)] });
    await settled();
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    await waitFor(() => expect(screen.getAllByTestId('continuous-tile')).toHaveLength(2));
    const ids = screen.getAllByTestId('continuous-tile').map((t) => t.getAttribute('data-media-id'));
    expect(ids).toEqual(['2', '3']);
  });

  it('🔴 the LIGHTBOX opens on the tile that was tapped — the filter cannot shift the index', async () => {
    // The knock-on this filter could have broken. `openLightbox` resolves the
    // tapped item to an INDEX into `displayItems`, and Player then seeks to it.
    //
    // 🔴 THE FIXTURE IS BUILT SO THE OFF-BY-ONE IS OBSERVABLE. The excluded item
    // is FIRST and the tapped tile is the FIRST VISIBLE one, so the two candidate
    // index spaces disagree by exactly one: correct → index 0 (item 2, "1 / 3"),
    // a `displayItems` that still held the excluded item → index 1 (item 3,
    // "2 / 3"). Tapping the LAST tile would not discriminate — an out-of-range
    // index clamps to the end and lands on the right media by accident.
    renderAtCeiling(SFW_LEVELS, { items: [mature(1, BrowsingLevel.X), img(2), img(3), img(4)] });
    await settled();
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    await waitFor(() => expect(screen.getAllByTestId('continuous-tile')).toHaveLength(3));
    await userEvent.click(screen.getAllByTestId('continuous-tile')[0]); // item 2
    const lightbox = await screen.findByTestId('lightbox');
    expect(within(lightbox).getByTestId('media-image')).toHaveAttribute('src', img(2).url);
    expect(within(lightbox).getByTestId('progress-label')).toHaveTextContent('1 / 3');
  });

  it('every item above the ceiling → the viewer says there is nothing to play', async () => {
    renderAtCeiling(SFW_LEVELS, { items: [mature(1, BrowsingLevel.R)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('viewer-empty')).toBeInTheDocument());
  });
});

describe('CollectionViewer — there is NO reveal affordance on any surface', () => {
  // 🔴 THE BEHAVIOURAL HALF OF THE DELETION GUARD. `deleted-mature-gate.test.ts`
  // proves the source no longer CONTAINS the mechanism; this proves that driving
  // the app at content the ceiling excludes produces no way to see it anyway —
  // no overlay, no blur filter, and no control offering to unlock anything.
  it('an above-ceiling item yields no reveal overlay, no blur, and no 18+ control', async () => {
    renderAtCeiling(SFW_LEVELS, { items: [mature(1, BrowsingLevel.XXX), img(2)] });
    await settled();
    await waitFor(() => expect(screen.getByTestId('media-image')).toBeInTheDocument());
    expect(screen.queryByTestId('maturity-reveal')).toBeNull();
    expect(screen.queryByTestId('cover-reveal')).toBeNull();
    expect(document.querySelector('[style*="blur("]')).toBeNull();
    for (const el of screen.queryAllByRole('button')) {
      expect(el.getAttribute('aria-label') ?? '').not.toMatch(/18|reveal|unblur/i);
      expect(el.textContent ?? '').not.toMatch(/18\+|reveal|unblur/i);
    }
  });
});

describe('CollectionViewer — ambient mode label (dogfood: "Cast" did not cast)', () => {
  it('the toggle reads "Ambient", not "Cast"', () => {
    renderViewer({ items: [img(1)] });
    const toggle = screen.getByTestId('cast-toggle');
    expect(toggle).toHaveTextContent('Ambient');
    expect(toggle).not.toHaveTextContent('Cast');
  });
});

describe('CollectionViewer — logged-out tipping (dogfood: tip failed only at the end)', () => {
  it('an anon viewer\'s curator tip prompts sign-in up front and does NOT open the modal', async () => {
    const onRequestSignIn = vi.fn();
    renderViewer({ items: [img(1), img(2)], viewerUserId: null, onRequestSignIn });
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    await userEvent.click(screen.getByTestId('chrome-tip-curator'));
    expect(onRequestSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tip-modal')).toBeNull();
  });

  it('an anon viewer\'s creator tip (classic player) prompts sign-in up front', async () => {
    const onRequestSignIn = vi.fn();
    renderViewer({ items: [img(1)], viewerUserId: null, onRequestSignIn });
    await userEvent.click(screen.getByTestId('tip-creator'));
    expect(onRequestSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tip-modal')).toBeNull();
  });
});

describe('CollectionViewer — self-tip explanation (dogfood: disabled with no reason)', () => {
  it('the disabled self-tip curator control explains why', async () => {
    // viewerUserId 5 === detail.curator.userId → self-tip.
    renderViewer({ items: [img(1)], viewerUserId: 5 });
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    const btn = screen.getByTestId('chrome-tip-curator');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', "You can't tip your own collection.");
  });
});

describe('CollectionViewer — default mode + mode switching', () => {
  it('defaults to the classic slideshow (Player)', () => {
    renderViewer();
    expect(screen.getByTestId('collection-viewer')).toHaveAttribute('data-mode', 'classic');
    expect(screen.getByTestId('player')).toBeInTheDocument();
  });

  it('🔴 switching modes preserves the loaded collection + paging (no refetch, same items)', async () => {
    const onLoadMore = vi.fn();
    const items = [vid(1), img(2), img(3), vid(4)];
    renderViewer({ items, onLoadMore, hasMore: false });

    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    expect(screen.getByTestId('collection-viewer')).toHaveAttribute('data-mode', 'continuous-horizontal');
    expect(within(screen.getByTestId('continuous-view')).getAllByTestId('continuous-tile')).toHaveLength(4);

    await userEvent.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    expect(within(screen.getByTestId('continuous-view')).getAllByTestId('continuous-tile')).toHaveLength(4);

    await userEvent.click(screen.getByTestId('mode-switcher-classic'));
    expect(screen.getByTestId('player')).toBeInTheDocument();

    // The collection was never re-fetched by switching modes.
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('shows collection-level chrome (pause / follow / tip curator) only in continuous modes', async () => {
    renderViewer();
    expect(screen.queryByTestId('toggle-pause')).toBeNull();
    expect(screen.queryByTestId('chrome-follow')).toBeNull();
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    expect(screen.getByTestId('toggle-pause')).toBeInTheDocument();
    expect(screen.getByTestId('chrome-follow')).toBeInTheDocument();
    expect(screen.getByTestId('chrome-tip-curator')).toBeInTheDocument();
  });
});

describe('CollectionViewer — mute (Feature 5)', () => {
  it('starts muted and the toggle flips <video muted>', async () => {
    renderViewer({ items: [vid(1), img(2)] });
    const video = screen.getByTestId('media-video') as HTMLVideoElement;
    expect(video.muted).toBe(true); // autoplay-policy safe default

    await userEvent.click(screen.getByTestId('viewer-settings-toggle'));
    await userEvent.click(screen.getByTestId('toggle-mute'));
    expect((screen.getByTestId('media-video') as HTMLVideoElement).muted).toBe(false);
  });
});

describe('CollectionViewer — shuffle (Feature 5, seeded + stable)', () => {
  it('reorders tiles deterministically when shuffle is toggled on', async () => {
    const items = [img(1), img(2), img(3), img(4), img(5)];
    renderViewer({ items });
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    const naturalOrder = screen.getAllByTestId('continuous-tile').map((t) => t.getAttribute('data-media-id'));
    expect(naturalOrder).toEqual(['1', '2', '3', '4', '5']);

    await userEvent.click(screen.getByTestId('viewer-settings-toggle'));
    await userEvent.click(screen.getByTestId('toggle-shuffle'));
    const shuffled = screen.getAllByTestId('continuous-tile').map((t) => t.getAttribute('data-media-id'));
    // A permutation of the same ids, and actually reordered (seed = collection id).
    expect([...shuffled].sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(shuffled).not.toEqual(naturalOrder);
  });
});

describe('CollectionViewer — media-type filter + re-page-to-fill (Feature 5)', () => {
  /** Page 1 = all images; loading more appends a page that contains the videos. */
  function FillHarness({ storage }: { storage: Storage }) {
    const [items, setItems] = useState<MediaItem[]>([img(1), img(2)]);
    const [hasMore, setHasMore] = useState(true);
    const loadMore = () => {
      setItems((prev) => [...prev, vid(10), vid(11)]);
      setHasMore(false);
    };
    return (
      <CollectionViewer
        detail={detail()}
        items={items}
        settings={{ secondsPerImage: 5, videoLoopCount: 1 }}
        onSecondsPerImageChange={() => {}}
        onVideoLoopCountChange={() => {}}
        viewerUserId={99}
        buzzBalance={0}
        followed={false}
        
        onFollowChange={() => {}} onNotice={() => {}}
        onFollowUncertain={() => {}}
        splitPlans={{}}
        onSplitPlanChange={() => {}}
        onTip={async () => true}
        tipping={false}
        isMobile={false}
        c={c}
        onExit={() => {}}
        storage={storage}
        reducedMotion
        hasMore={hasMore}
        onLoadMore={loadMore}
      />
    );
  }

  it('🔴 a filter that empties the loaded set keeps paging until later matches surface', async () => {
    render(<FillHarness storage={memStorage()} />);
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    await userEvent.click(screen.getByTestId('viewer-settings-toggle'));

    // Filter to videos — page 1 has none, so the view is empty and must re-page.
    await userEvent.click(screen.getByTestId('filter-videos'));

    // After the fill fetch appends the video page, the videos surface.
    await waitFor(() => {
      const tiles = screen.getAllByTestId('continuous-tile');
      expect(tiles).toHaveLength(2);
      expect(tiles.every((t) => t.getAttribute('data-media-type') === 'video')).toBe(true);
    });
  });

  it('filtering to images (present on page 1) shows them immediately', async () => {
    renderViewer({ items: [img(1), vid(2), img(3)] });
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    await userEvent.click(screen.getByTestId('viewer-settings-toggle'));
    await userEvent.click(screen.getByTestId('filter-images'));
    const tiles = screen.getAllByTestId('continuous-tile');
    expect(tiles).toHaveLength(2);
    expect(tiles.every((t) => t.getAttribute('data-media-type') === 'image')).toBe(true);
  });
});

describe('CollectionViewer — tap → lightbox (Feature 3)', () => {
  it('opens the classic single-item view with tip creator + curator, follow, play', async () => {
    renderViewer({ items: [img(1), vid(2), img(3)] });
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    await userEvent.click(screen.getAllByTestId('continuous-tile')[1]);

    const lightbox = await screen.findByTestId('lightbox');
    expect(within(lightbox).getByTestId('player')).toBeInTheDocument();
    // Full single-item controls are carried over.
    expect(within(lightbox).getByTestId('tip-creator')).toBeInTheDocument();
    expect(within(lightbox).getByTestId('tip-curator')).toBeInTheDocument();
    expect(within(lightbox).getByTestId('follow-toggle')).toBeInTheDocument();
    expect(within(lightbox).getByTestId('ctrl-play')).toBeInTheDocument();

    // The lightbox opened on the tapped item (index 1 of the display order).
    expect(within(lightbox).getByTestId('progress-label')).toHaveTextContent('2 / 3');
  });
});

describe('CollectionViewer — remember mode + per-collection isolation (Feature 5)', () => {
  it('restores the last-used mode on reopen, and a different collection does not inherit it', async () => {
    const storage = memStorage();
    const { unmount } = renderViewer({ detail: detail(101), storage });
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    // persisted immediately on switch
    expect(loadCollectionState(101, storage).mode).toBe('continuous-vertical');
    unmount();

    // Reopen collection 101 → restored to the wall.
    renderViewer({ detail: detail(101), storage });
    expect(screen.getByTestId('collection-viewer')).toHaveAttribute('data-mode', 'continuous-vertical');

    // A DIFFERENT collection (202) starts at the default classic.
    renderViewer({ detail: detail(202), storage });
    const viewers = screen.getAllByTestId('collection-viewer');
    expect(viewers[viewers.length - 1]).toHaveAttribute('data-mode', 'classic');
  });
});

describe('CollectionViewer — curator tip from continuous chrome', () => {
  it('opens the tip modal for the curator', async () => {
    renderViewer();
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-horizontal'));
    await userEvent.click(screen.getByTestId('chrome-tip-curator'));
    expect(await screen.findByTestId('tip-modal')).toBeInTheDocument();
  });
});
