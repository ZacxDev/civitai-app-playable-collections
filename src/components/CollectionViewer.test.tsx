import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CollectionViewer } from './CollectionViewer.js';
import { palette } from '../theme.js';
import { loadCollectionState } from '../view-modes.js';
import type { CollectionDetail, MediaItem } from '../types.js';

const c = palette(true);

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
    followPending: false,
    onToggleFollow: () => {},
    onTip: async () => true,
    tipping: false,
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

describe('CollectionViewer — content maturity (badge + blur-until-tap, ship-blocker #3)', () => {
  it('blurs a mature current item and reveals it on tap (classic Player)', async () => {
    renderViewer({ items: [mature(1, 4), img(2)] });
    // PG-13 app default: an R item is badged + blurred until revealed.
    expect(screen.getByTestId('maturity-badge')).toHaveTextContent('R');
    const image = screen.getByTestId('media-image');
    expect(image).toHaveStyle({ filter: 'blur(36px)' });
    expect(screen.getByTestId('maturity-reveal')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('maturity-reveal'));
    expect(screen.queryByTestId('maturity-reveal')).toBeNull();
    expect(screen.getByTestId('media-image')).not.toHaveStyle({ filter: 'blur(36px)' });
  });

  it('does NOT blur or badge a PG item', () => {
    renderViewer({ items: [img(1)] });
    expect(screen.queryByTestId('maturity-badge')).toBeNull();
    expect(screen.queryByTestId('maturity-reveal')).toBeNull();
    expect(screen.getByTestId('media-image')).not.toHaveStyle({ filter: 'blur(36px)' });
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
        followPending={false}
        onToggleFollow={() => {}}
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
