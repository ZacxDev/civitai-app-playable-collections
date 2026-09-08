import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import { BrowsingLevel, SFW_LEVELS } from '@civitai/app-sdk/blocks';

import { ContinuousView } from './ContinuousView.js';
import { palette } from '../theme.js';
import { flushIntersections } from '../test-setup.js';
import type { MediaItem } from '../types.js';

const c = palette();
function img(id: number): MediaItem {
  return { mediaId: id, type: 'image', url: `https://x.invalid/i/${id}.jpg`, width: 100, height: 100, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}
function vid(id: number): MediaItem {
  return { mediaId: id, type: 'video', url: `https://x.invalid/v/${id}.mp4`, width: 100, height: 100, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}

function renderView(over: Partial<React.ComponentProps<typeof ContinuousView>> = {}) {
  const props: React.ComponentProps<typeof ContinuousView> = {
    orientation: 'horizontal',
    items: [img(1), img(2), img(3)],
    muted: true,
    scrollSpeed: 40,
    reducedMotion: true, // default: no auto-scroll → no clones (cleaner assertions)
    paused: false,
    autoplayCap: 5,
    c,
    onTapItem: () => {},
    onTogglePause: () => {},
    ...over,
  };
  return render(<ContinuousView {...props} />);
}

describe('ContinuousView — structure + orientation', () => {
  it('renders one tile per item in horizontal (ticker) orientation', () => {
    renderView({ orientation: 'horizontal' });
    const view = screen.getByTestId('continuous-view');
    expect(view).toHaveAttribute('data-orientation', 'horizontal');
    expect(within(view).getAllByTestId('continuous-tile')).toHaveLength(3);
  });

  it('renders a responsive column wall in vertical orientation', () => {
    renderView({ orientation: 'vertical', items: [img(1), img(2), img(3), img(4)] });
    const view = screen.getByTestId('continuous-view');
    expect(view).toHaveAttribute('data-orientation', 'vertical');
    expect(within(view).getAllByTestId('continuous-tile')).toHaveLength(4);
  });
});

describe('ContinuousView reports the media this surface stands for', () => {
  it('names the first item when the observer has said nothing yet', () => {
    // 🔴 THE FALLBACK IS NOT COSMETIC. `inViewIds` is empty until the
    // IntersectionObserver's first callback (and forever in an environment without
    // one). Without the fallback the creator side of the tip picker resolves to
    // `null` on this surface, and the picker silently offers a curator-only tip —
    // a collapse that looks exactly like the self-tip collapse and is not one.
    const seen = vi.fn();
    renderView({ items: [img(7), img(8)], onCurrentItemChange: seen });
    expect(seen.mock.calls.at(-1)?.[0]).toMatchObject({ mediaId: 7 });
  });

  it('🔴 reports WITHIN THE COMMIT, not on the scheduler\'s timetable', () => {
    // The twin of `Player.test.tsx`'s probe of the same name — read that one for
    // the money bug this pins and why ordering, not timing, is the discriminator.
    // Both surfaces feed the SAME owner state, so a guard on one of them leaves
    // the other free to regress: the Player-side probe passes with THIS
    // component's report still deferred.
    let verdict = 'probe did not run';
    function Probe() {
      const reported = useRef(false);
      useLayoutEffect(() => {
        verdict = reported.current ? 'REPORTED-IN-COMMIT' : 'DEFERRED-PAST-COMMIT';
      }, []);
      return (
        <ContinuousView
          orientation="vertical"
          items={[img(1), img(2)]}
          muted
          scrollSpeed={40}
          reducedMotion
          paused={false}
          autoplayCap={5}
          c={c}
          onTapItem={() => {}}
          onTogglePause={() => {}}
          onCurrentItemChange={() => {
            reported.current = true;
          }}
        />
      );
    }
    render(<Probe />);
    expect(verdict).toBe('REPORTED-IN-COMMIT');
  });
});

describe('ContinuousView — reduced motion (🔴 accessibility branch)', () => {
  it('disables auto-scroll and becomes user-scrollable when reduced motion is on', () => {
    renderView({ reducedMotion: true });
    expect(screen.getByTestId('continuous-view')).toHaveAttribute('data-autoscroll', 'off');
    // No seamless clones exist when not auto-scrolling.
    expect(screen.getByTestId('continuous-track').querySelectorAll('[data-copy="clone"]')).toHaveLength(0);
  });

  it('runs auto-scroll (and renders a seamless clone) when motion is allowed and not paused', () => {
    renderView({ reducedMotion: false, paused: false });
    expect(screen.getByTestId('continuous-view')).toHaveAttribute('data-autoscroll', 'on');
    expect(screen.getByTestId('continuous-track').querySelectorAll('[data-copy="clone"]').length).toBeGreaterThan(0);
  });

  it('a pause disables auto-scroll even with motion allowed', () => {
    renderView({ reducedMotion: false, paused: true });
    expect(screen.getByTestId('continuous-view')).toHaveAttribute('data-autoscroll', 'off');
  });
});

describe('ContinuousView — lazy media mount', () => {
  it('holds image tiles on data-src until they intersect, then swaps to src', async () => {
    renderView({ items: [img(1), img(2)], reducedMotion: true });
    const imgs = screen.getAllByTestId('continuous-image');
    // before intersection: deferred (data-src set, no src)
    expect(imgs[0]).toHaveAttribute('data-src');
    expect(imgs[0].getAttribute('src')).toBeFalsy();
    await act(async () => flushIntersections(true));
    // after intersection: swapped in
    expect(screen.getAllByTestId('continuous-image')[0].getAttribute('src')).toBeTruthy();
  });
});

describe('ContinuousView — capped video autoplay (🔴 perf guard)', () => {
  it('plays at most `autoplayCap` in-view videos; the rest show a poster', async () => {
    const videos = Array.from({ length: 8 }, (_, i) => vid(i + 1));
    renderView({ items: videos, autoplayCap: 5, reducedMotion: true });
    // Nothing is "in view" until the observer fires.
    await act(async () => flushIntersections(true));
    // Exactly the cap number of <video> elements mount + play; others are posters.
    const playing = screen.getAllByTestId('continuous-tile').filter((t) => t.getAttribute('data-playing') === 'true');
    expect(playing).toHaveLength(5);
  });
});

describe('ContinuousView — content maturity is the HOST ceiling, not a local blur', () => {
  // 🔴 THIS REPLACES A "badges and blurs a mature tile" TEST. That behaviour is
  // gone: an above-ceiling tile is not blurred, it is not in the wall at all, so
  // there is no tile to tap and nothing to reveal. `renderView` mounts the
  // component with NO <Harness>, so the ceiling reads `undefined` → SFW-only,
  // which is the fail-closed arm.

  const at = (nsfwLevel: number, id = 1): MediaItem => ({ ...img(id), nsfwLevel });

  it('🔴 an above-ceiling tile is ABSENT — no tile, no badge, no blur', () => {
    renderView({ items: [at(BrowsingLevel.X, 1), img(2)], reducedMotion: true });
    const tiles = screen.getAllByTestId('continuous-tile');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toHaveAttribute('data-media-id', '2');
    expect(screen.queryAllByTestId('maturity-badge')).toHaveLength(0);
    expect(document.querySelector('[style*="blur("]')).toBeNull();
  });

  it('a within-ceiling PG-13 tile renders WITH its badge (a badge labels, it does not gate)', () => {
    renderView({ items: [at(BrowsingLevel.PG13, 1), img(2)], reducedMotion: true });
    expect(screen.getAllByTestId('continuous-tile')).toHaveLength(2);
    const badges = screen.getAllByTestId('maturity-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('PG-13');
    expect(screen.getAllByTestId('continuous-image')[0]).not.toHaveStyle({ filter: 'blur(36px)' });
  });

  it('🔴 an UNRATED (0) tile RENDERS on a SFW ceiling, badged "Unrated"', () => {
    // 🔴 REVERSED: this asserted the tile was ABSENT. The server permits unrated at
    // every ceiling (block-collections.service.ts:193, :359), so hiding it was the
    // app overriding the platform — and strictly worse than the blur it replaced.
    // No <Harness> here, i.e. the STRICTEST (fail-closed SFW) ceiling, which is
    // where a wrongly-strict rule would show up first.
    renderView({ items: [at(0, 1), img(2)], reducedMotion: true });
    const tiles = screen.getAllByTestId('continuous-tile');
    expect(tiles).toHaveLength(2);
    expect(tiles.map((t) => t.getAttribute('data-media-id'))).toEqual(['1', '2']);
    expect(screen.getAllByTestId('maturity-badge')[0]).toHaveTextContent('Unrated');
  });

  // ---- the ceiling and the item disagree, in both directions ---------------
  function renderAtCeiling(ceiling: number, items: MediaItem[]) {
    return render(
      <Harness showLog={false} maxBrowsingLevel={ceiling}>
        <ContinuousView
          orientation="horizontal"
          items={items}
          muted
          scrollSpeed={40}
          reducedMotion
          paused={false}
          autoplayCap={5}
          c={c}
          onTapItem={() => {}}
          onTogglePause={() => {}}
        />
      </Harness>,
    );
  }

  it('🔴 SAME X tile, an ALL-LEVELS ceiling → it RENDERS, badged X', async () => {
    // Without this the suite would be pinning "X is hidden" rather than "X is
    // hidden BY THIS CEILING" — the mutant that ignores the ceiling passes the
    // three tests above and fails only here.
    renderAtCeiling(
      SFW_LEVELS | BrowsingLevel.R | BrowsingLevel.X | BrowsingLevel.XXX,
      [at(BrowsingLevel.X, 1), img(2)],
    );
    await waitFor(() => expect(screen.getAllByTestId('continuous-tile')).toHaveLength(2));
    expect(screen.getAllByTestId('maturity-badge')[0]).toHaveTextContent('X');
  });

  it('🔴 SAME up-to-R ceiling, two different items → R is in, X is out', async () => {
    renderAtCeiling(SFW_LEVELS | BrowsingLevel.R, [at(BrowsingLevel.R, 1), at(BrowsingLevel.X, 2)]);
    await waitFor(() => expect(screen.getAllByTestId('continuous-tile')).toHaveLength(1));
    expect(screen.getAllByTestId('continuous-tile')[0]).toHaveAttribute('data-media-id', '1');
    expect(screen.getAllByTestId('maturity-badge')[0]).toHaveTextContent('R');
  });
});

describe('ContinuousView — brittle poster fallback (ship-blocker #5)', () => {
  it('falls back to a placeholder when a video poster 404s', () => {
    renderView({ items: [vid(1)], reducedMotion: true });
    const poster = screen.getByTestId('continuous-poster');
    fireEvent.error(poster);
    expect(screen.getByTestId('continuous-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('continuous-poster')).toBeNull();
  });

  it('falls back to a placeholder when a lazy image errors', async () => {
    renderView({ items: [img(1)], reducedMotion: true });
    await act(async () => flushIntersections(true)); // swap data-src → src
    fireEvent.error(screen.getByTestId('continuous-image'));
    expect(screen.getByTestId('continuous-placeholder')).toBeInTheDocument();
  });
});

describe('ContinuousView — page-ahead + tap', () => {
  it('calls onLoadMore when the tail sentinel intersects', async () => {
    const onLoadMore = vi.fn();
    renderView({ hasMore: true, loadingMore: false, onLoadMore, reducedMotion: true });
    expect(screen.getByTestId('continuous-sentinel')).toBeInTheDocument();
    await act(async () => flushIntersections(true));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('a tile tap bubbles the tapped item up (→ lightbox)', async () => {
    const onTapItem = vi.fn();
    renderView({ items: [img(7), img(8)], onTapItem, reducedMotion: true });
    await userEvent.click(screen.getAllByTestId('continuous-tile')[1]);
    expect(onTapItem).toHaveBeenCalledWith(expect.objectContaining({ mediaId: 8 }));
  });
});
