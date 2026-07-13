import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Player } from './components/Player.js';
import { usePlayerSettings, STORAGE_KEYS } from './settings.js';
import { palette } from './theme.js';
import type { CollectionDetail, MediaItem } from './types.js';

const c = palette(true);

function img(id: number): MediaItem {
  return { mediaId: id, type: 'image', url: `i/${id}`, width: 1, height: 1, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}
function vid(id: number): MediaItem {
  return { mediaId: id, type: 'video', url: `v/${id}`, width: 1, height: 1, creator: { userId: 1, username: 'a' }, nsfwLevel: 1 };
}
const detail: CollectionDetail = {
  id: 1,
  name: 'Test',
  description: null,
  curator: { userId: 5, username: 'cur' },
  isPublic: true,
  followed: false,
};

/**
 * Wrapper that wires the REAL localStorage-backed settings hook to the Player,
 * so the in-app sliders drive both the persisted store and the player behavior.
 */
function Wrapper({ items }: { items: MediaItem[] }) {
  const { settings, setSecondsPerImage, setVideoLoopCount } = usePlayerSettings();
  return (
    <Player
      detail={detail}
      items={items}
      settings={settings}
      onSecondsPerImageChange={setSecondsPerImage}
      onVideoLoopCountChange={setVideoLoopCount}
      viewerUserId={99}
      buzzBalance={100}
      followed={false}
      followPending={false}
      onToggleFollow={() => {}}
      onTip={async () => true}
      tipping={false}
      isMobile={false}
      c={c}
      onExit={() => {}}
    />
  );
}

function openSettings() {
  act(() => {
    fireEvent.click(screen.getByTestId('ctrl-settings'));
  });
}

describe('in-app settings sliders — render + persist + drive the player', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders the sliders with the current values', () => {
    render(<Wrapper items={[img(1), img(2)]} />);
    openSettings();
    expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
    expect(screen.getByTestId('seconds-per-image-value')).toHaveTextContent('5s'); // default
    expect(screen.getByTestId('video-loop-count-value')).toHaveTextContent('1×');
  });

  it('changing the seconds slider updates the store (localStorage + display)', () => {
    render(<Wrapper items={[img(1), img(2)]} />);
    openSettings();
    act(() => {
      fireEvent.change(screen.getByTestId('set-seconds-per-image'), { target: { value: '9' } });
    });
    expect(screen.getByTestId('seconds-per-image-value')).toHaveTextContent('9s');
    expect(window.localStorage.getItem(STORAGE_KEYS.secondsPerImage)).toBe('9');
  });

  it('changing seconds-per-image changes the auto-advance cadence (fake timers)', () => {
    render(<Wrapper items={[img(1), img(2)]} />);
    openSettings();
    // set a 2s cadence
    act(() => {
      fireEvent.change(screen.getByTestId('set-seconds-per-image'), { target: { value: '2' } });
    });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2'); // not yet
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2'); // advanced at ~2s
  });

  it('changing video-loop-count changes video-loop-then-advance (fake timers)', () => {
    render(<Wrapper items={[vid(1), img(2)]} />);
    openSettings();
    // require 3 loops before advancing
    act(() => {
      fireEvent.change(screen.getByTestId('set-video-loop-count'), { target: { value: '3' } });
    });
    expect(screen.getByTestId('video-loop-count-value')).toHaveTextContent('3×');
    expect(window.localStorage.getItem(STORAGE_KEYS.videoLoopCount)).toBe('3');

    const video = screen.getByTestId('media-video');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
    // two 'ended' events => still on the video (loops 1, 2 of 3)
    act(() => {
      fireEvent.ended(video);
    });
    act(() => {
      fireEvent.ended(video);
    });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
    // third 'ended' => advance to the image
    act(() => {
      fireEvent.ended(video);
    });
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2');
  });
});
