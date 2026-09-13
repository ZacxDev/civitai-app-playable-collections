// ---------------------------------------------------------------------------
// 🔴 WHAT `prefers-reduced-motion: reduce` ACTUALLY DOES IN THIS APP
// ---------------------------------------------------------------------------
//
// Phase 3 recorded reduced-motion as "unaudited, and nothing in the repo
// measures it". Two things were true at once: the DECISION was pinned (the pure
// `shouldAutoScroll(reducedMotion, paused)` in `modes/scroll-engine.test.ts`,
// and `ContinuousView` driven by a reducedMotion PROP), and the WIRING was not.
// Every existing test hands the flag in as a prop. Nothing anywhere asserted
// that the OS preference reaches a surface at all — `useReducedMotion()` is
// called in exactly one place (`CollectionViewer`), and a seam that no test
// crosses is the classic shape of a feature that is pinned in isolation and
// broken together.
//
// So this file asserts the RELATIONSHIP — media query → hook → surface — and it
// asserts it in BOTH directions, because a reduced-motion test that passes under
// `reduce` AND under `no-preference` is measuring nothing.
//
// 🔴 AND IT RECORDS A FINDING RATHER THAN AN INTENT. The app does NOT stop the
// ~5 s slideshow auto-advance under reduced motion. `usePlayer`'s image timer
// consults nothing but `playing` and `secondsPerImage`; `Player` reads
// `reducedMotion` in exactly one effect, guarded by `if (!cast) return`. So
// reduced motion is honoured on the continuous surfaces and in ambient/cast
// mode, and is INERT on the default classic surface. The tests below pin what is
// there; they deliberately do not assert the behaviour the phase may have
// intended. If that is later judged wrong, the fix is a code change and these
// assertions flip with it — which is the point of pinning the real behaviour.
//
// ⚠️ THE CSS HALF IS NOT COVERED HERE AND CANNOT BE. `src/index.css` carries a
// real `@media (prefers-reduced-motion: reduce)` block (card transitions off,
// skeleton shimmer off). jsdom applies no stylesheets and evaluates no media
// queries, so an assertion about it here would pass whatever the CSS said. That
// needs the browser tier plus a Playwright `reducedMotion` context option, which
// this repo's browser project does not configure — recorded as an open gap, not
// papered over with a jsdom test that could never fail.

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import { Player, type PlayerProps } from './components/Player.js';
import { createFakeApi } from './fake-api.js';
import { SECONDS_PER_IMAGE } from './settings.js';
import { setReducedMotion } from './test-setup.js';
import { palette } from './theme.js';
import type { MediaItem } from './types.js';

const c = palette();

function img(mediaId: number): MediaItem {
  return {
    mediaId,
    type: 'image',
    url: `https://x.invalid/i/${mediaId}.jpg`,
    width: 10,
    height: 10,
    creator: { userId: 7, username: 'creator' },
    nsfwLevel: 1,
  };
}

/** One whole image interval, as the auto-advance timer measures it. */
function letOneImageIntervalPass() {
  act(() => {
    vi.advanceTimersByTime(SECONDS_PER_IMAGE.default * 1000 + 50);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The seam: the OS preference, through `useReducedMotion()`, onto a surface.
// ---------------------------------------------------------------------------
//
// 🔴 EACH TEST BELOW CARRIES ITS OWN CONTROL, IN THE SAME RENDER. Under one
// media-query setting it asserts the classic surface (which ignores the
// preference) AND the wall surface (which honours it). That is what makes the
// wall assertion non-vacuous: a stub that answered nothing, or a hook that was
// never called, would give the same `data-autoscroll` in both settings, and the
// pair of tests would then disagree with each other.

async function openThenSwitchToWall(reduce: boolean) {
  setReducedMotion(reduce);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const api = createFakeApi({ viewerUserId: 99 });
  render(
    <Harness viewer={{ id: 99, username: 'me' }} theme="dark" showLog={false}>
      <App api={api} isTipGranted={() => true} />
    </Harness>,
  );
  const grid = await screen.findByTestId('collection-grid');
  await user.click(within(grid).getAllByTestId('collection-card')[0]);
  await screen.findByTestId('player');
  return user;
}

describe('prefers-reduced-motion, end to end through the real media query', () => {
  it('🔴 under REDUCE: the wall stops drifting, and the classic slideshow still auto-advances', async () => {
    const user = await openThenSwitchToWall(true);

    // (a) THE FINDING. The default surface is the classic slideshow, and it
    // advances on its own timer regardless of the preference. Nothing in
    // `usePlayer` or in Player's non-cast path reads `reducedMotion`.
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
    letOneImageIntervalPass();
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 3');

    // (b) THE CONTROL, in the same render and the same media-query state: the
    // continuous wall DOES honour it. If the query were not reaching the hook at
    // all, this would read 'on' — which is exactly what the paired test below
    // asserts for the opposite setting.
    await user.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    const view = await screen.findByTestId('continuous-view');
    expect(view).toHaveAttribute('data-autoscroll', 'off');
  });

  it('🔴 under NO-PREFERENCE: the wall drifts — so the assertion above can move', async () => {
    const user = await openThenSwitchToWall(false);

    // Same classic behaviour — the preference changes nothing here. Stated as an
    // assertion rather than a comment so a future gate on the classic timer
    // fails HERE too, not only in the reduce arm.
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
    letOneImageIntervalPass();
    expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 3');

    await user.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    const view = await screen.findByTestId('continuous-view');
    expect(view).toHaveAttribute('data-autoscroll', 'on');
  });
});

// ---------------------------------------------------------------------------
// Cast / ambient mode — the ONE place the transport itself honours it.
// ---------------------------------------------------------------------------

function PlayerHost(props: Partial<PlayerProps> & { items: MediaItem[] }) {
  const full: PlayerProps = {
    settings: { secondsPerImage: SECONDS_PER_IMAGE.default, videoLoopCount: 1 },
    onSecondsPerImageChange: () => {},
    onVideoLoopCountChange: () => {},
    isMobile: false,
    c,
    onExit: () => {},
    ...props,
  };
  return <Player {...full} />;
}

describe('Player: reducedMotion gates the AMBIENT transport and nothing else', () => {
  // In cast mode all chrome is hidden, so there is no `progress-label` to read.
  // `onPositionChange` is the surface-independent observable.
  const positions = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map((a) => a[0]);

  it('🔴 cast + reduce: the ambient transport is PAUSED — the media does not advance', async () => {
    const onPositionChange = vi.fn();
    render(<PlayerHost items={[img(1), img(2), img(3)]} cast reducedMotion onPositionChange={onPositionChange} />);
    await waitFor(() => expect(onPositionChange).toHaveBeenCalled());
    letOneImageIntervalPass();
    letOneImageIntervalPass();
    expect(positions(onPositionChange).at(-1)).toBe(0);
  });

  it('cast + no reduce: the ambient transport runs — the control arm for the case above', async () => {
    const onPositionChange = vi.fn();
    render(
      <PlayerHost items={[img(1), img(2), img(3)]} cast reducedMotion={false} onPositionChange={onPositionChange} />,
    );
    await waitFor(() => expect(onPositionChange).toHaveBeenCalled());
    letOneImageIntervalPass();
    expect(positions(onPositionChange).at(-1)).toBe(1);
  });

  it('🔴 NOT cast + reduce: the slideshow advances anyway — the gate is cast-only', async () => {
    // The same flag, the same component, the same interval: only `cast` differs
    // from the first case. That is the whole of the finding, in one pair.
    const onPositionChange = vi.fn();
    render(<PlayerHost items={[img(1), img(2), img(3)]} cast={false} reducedMotion onPositionChange={onPositionChange} />);
    await waitFor(() => expect(onPositionChange).toHaveBeenCalled());
    letOneImageIntervalPass();
    expect(positions(onPositionChange).at(-1)).toBe(1);
  });
});
