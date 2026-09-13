// ---------------------------------------------------------------------------
// 🔴 MENU / POPOVER SEMANTICS — WHAT THE CONTROLS ACTUALLY ANNOUNCE AND DO
// ---------------------------------------------------------------------------
//
// Phase 3 recorded "menu semantics" as unaudited. Enumerating the surfaces
// first, because two of them were already covered and re-testing them would be
// coverage theatre:
//
//   ALREADY PINNED, NOT DUPLICATED HERE
//     - the view-mode switcher (`ModeSwitcher` / `SegmentedControl`) —
//       `components/ModeSwitcher.test.tsx` pins role=radiogroup, aria-checked,
//       the roving tabindex and Arrow/Home/End selection+focus.
//     - the Discover/Mine tablist — `App.test.tsx` pins role=tab, aria-controls
//       onto a real tabpanel, and roving focus.
//     - the lightbox dialog — `CollectionViewer.test.tsx` + `FocusTrap.test.tsx`
//       pin role=dialog/aria-modal, the trap, and focus restoration on close.
//
//   UNPINNED, AND THIS FILE'S SUBJECT
//     - the viewer's ⚙ SETTINGS DISCLOSURE (`viewer-settings-toggle` →
//       `viewer-settings`): nothing asserted its `aria-expanded`, its keyboard
//       operation, what focus does, or what Escape does to it.
//     - the Player's own ⚙ (`ctrl-settings` → `settings-panel`), which is the
//       control the LIGHTBOX surface shows.
//
// 🔴 TWO FINDINGS ARE PINNED HERE AS FOUND, NOT AS INTENDED.
//   (1) Escape does NOT dismiss the settings popover. In `classic` mode Escape
//       is caught by Player's window-level handler and EXITS THE WHOLE
//       COLLECTION, popover and all. In the continuous modes no such handler is
//       mounted, so Escape does nothing at all and the popover stays open. The
//       two surfaces therefore disagree about the same key.
//   (2) The disclosure moves no focus — opening leaves focus on the toggle, and
//       nothing inside the panel is focused. For a non-modal disclosure that is
//       a defensible choice; it is recorded so a future change is a deliberate
//       one. It also means there is nothing to restore on close, which is why
//       there is no focus-restoration assertion below.
//
// Neither is "fixed" here. They are behaviour, and the tests say what the
// behaviour is.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import { Player, type PlayerProps } from './components/Player.js';
import { createFakeApi } from './fake-api.js';
import { palette } from './theme.js';
import type { MediaItem } from './types.js';

const c = palette();

async function openNeon() {
  const api = createFakeApi({ viewerUserId: 99 });
  render(
    <Harness viewer={{ id: 99, username: 'me' }} theme="dark" showLog={false}>
      <App api={api} isTipGranted={() => true} />
    </Harness>,
  );
  const grid = await screen.findByTestId('collection-grid');
  await userEvent.click(within(grid).getAllByTestId('collection-card')[0]);
  await screen.findByTestId('player');
}

describe('the viewer ⚙ settings disclosure', () => {
  it('announces itself with aria-expanded, and the panel appears and disappears with it', async () => {
    await openNeon();
    const toggle = screen.getByTestId('viewer-settings-toggle');

    // 🔴 BOTH HALVES, IN BOTH DIRECTIONS. An `aria-expanded` that is merely
    // PRESENT tells a screen-reader user nothing; the pair (attribute, panel)
    // has to move together, and back again — a toggle that only ever opens
    // passes a one-way test.
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('viewer-settings')).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('viewer-settings')).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('viewer-settings')).toBeNull();
  });

  it('Enter activates it from the keyboard', async () => {
    await openNeon();
    const toggle = screen.getByTestId('viewer-settings-toggle');
    toggle.focus();
    expect(toggle).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('viewer-settings')).toBeInTheDocument();

    await userEvent.keyboard('{Enter}');
    expect(screen.queryByTestId('viewer-settings')).toBeNull();
  });

  it('🔴 FINDING: SPACE does NOT activate it — the global play/pause shortcut eats the key', async () => {
    // 🔴 A REAL KEYBOARD DEFECT, PINNED AS FOUND. A `<button>` must respond to
    // both Enter and Space; here Player's window-level shortcut handler runs
    // first, matches `case ' '`, calls `preventDefault()` — which cancels the
    // button's default activation — and toggles PLAYBACK instead. Its early-out
    // covers INPUT / TEXTAREA / SELECT / contenteditable, and a focused BUTTON is
    // none of those.
    //
    // The second half is what makes this a finding rather than a shrug: the key
    // is not merely lost, it operates a DIFFERENT control while focus sits on
    // this one.
    await openNeon();
    const toggle = screen.getByTestId('viewer-settings-toggle');
    toggle.focus();
    const playingBefore = screen.getByTestId('ctrl-play').getAttribute('aria-pressed');

    await userEvent.keyboard(' ');

    expect(screen.queryByTestId('viewer-settings')).toBeNull(); // not activated
    expect(screen.getByTestId('ctrl-play').getAttribute('aria-pressed')).not.toBe(playingBefore);
  });

  it('🔴 FINDING: opening moves NO focus — it stays on the toggle, not in the panel', async () => {
    await openNeon();
    const toggle = screen.getByTestId('viewer-settings-toggle');
    toggle.focus();
    await userEvent.keyboard('{Enter}');

    const panel = screen.getByTestId('viewer-settings');
    // The panel does contain focusable controls — so "nothing was focused" is a
    // real observation about the disclosure, not an artefact of an empty panel.
    expect(within(panel).getAllByRole('button').length).toBeGreaterThan(0);
    expect(toggle).toHaveFocus();
    expect(panel.contains(document.activeElement)).toBe(false);
  });

  it('🔴 FINDING: in CLASSIC mode Escape does not close the popover — it exits the whole collection', async () => {
    await openNeon();
    await userEvent.click(screen.getByTestId('viewer-settings-toggle'));
    expect(screen.getByTestId('viewer-settings')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    // Back on the grid: the popover is gone because the collection is.
    expect(await screen.findByTestId('collection-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('viewer-settings')).toBeNull();
    expect(screen.queryByTestId('viewer-settings-toggle')).toBeNull();
  });

  it('🔴 FINDING: in a CONTINUOUS mode Escape does nothing at all — the popover stays open', async () => {
    // The discriminator for the case above: same key, same popover, different
    // surface. Player's window-level Escape handler is only mounted on the
    // classic surface, so here nothing is listening.
    await openNeon();
    await userEvent.click(screen.getByTestId('mode-switcher-continuous-vertical'));
    await screen.findByTestId('continuous-view');

    await userEvent.click(screen.getByTestId('viewer-settings-toggle'));
    expect(screen.getByTestId('viewer-settings')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.getByTestId('viewer-settings')).toBeInTheDocument();
    expect(screen.getByTestId('viewer-settings-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('collection-grid')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Player's own ⚙ — the control the LIGHTBOX surface shows.
// ---------------------------------------------------------------------------

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

function PlayerHost(props: Partial<PlayerProps> & { items: MediaItem[] }) {
  const full: PlayerProps = {
    settings: { secondsPerImage: 5, videoLoopCount: 1 },
    onSecondsPerImageChange: () => {},
    onVideoLoopCountChange: () => {},
    isMobile: false,
    c,
    onExit: () => {},
    ...props,
  };
  return <Player {...full} />;
}

describe("the Player's ⚙ settings control", () => {
  it('carries BOTH aria-pressed and aria-expanded, and both track the panel', async () => {
    // 🔴 BOTH ARE ASSERTED BECAUSE BOTH ARE THERE. Doubling a toggle button as a
    // disclosure is a deliberate choice in this control; a test that read only
    // one of them would go green over the other silently going stale, which is
    // worse than either attribute being absent.
    render(<PlayerHost items={[img(1), img(2)]} />);
    const toggle = screen.getByTestId('ctrl-settings');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('settings-panel')).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const panel = screen.getByTestId('settings-panel');
    expect(panel).toHaveAttribute('role', 'group');
    expect(panel).toHaveAttribute('aria-label', 'Playback settings');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('settings-panel')).toBeNull();
  });

  it('the transport buttons carry accessible names, and the play toggle reports its state', async () => {
    render(<PlayerHost items={[img(1), img(2)]} />);
    expect(screen.getByTestId('ctrl-prev')).toHaveAccessibleName('Previous');
    expect(screen.getByTestId('ctrl-next')).toHaveAccessibleName('Next');
    expect(screen.getByTestId('ctrl-fullscreen')).toHaveAttribute('aria-pressed', 'false');

    const play = screen.getByTestId('ctrl-play');
    const before = play.getAttribute('aria-pressed');
    await userEvent.click(play);
    await waitFor(() =>
      expect(screen.getByTestId('ctrl-play').getAttribute('aria-pressed')).not.toBe(before),
    );
    // The accessible name has to move with the state — a button that says
    // "Pause" while `aria-pressed=false` is worse than one that says neither.
    const after = screen.getByTestId('ctrl-play');
    expect(after).toHaveAccessibleName(after.getAttribute('aria-pressed') === 'true' ? 'Pause' : 'Play');
  });
});

describe('the ambient (cast) control pair', () => {
  it('🔴 INVARIANT GUARD (not regression coverage): the ambient ENTRY button is not a toggle', async () => {
    // Labelled as an invariant guard deliberately: `aria-pressed={false}` on
    // `cast-toggle` is a hardcoded literal that no code path has ever changed,
    // so nothing has regressed here and this pins an intent rather than a fix.
    // It is worth a line because the testid says "toggle" while the control is
    // one-way — entering ambient hides all chrome and `cast-exit` is the way
    // back — so the next reader's obvious "make it reflect state" change should
    // have to notice this.
    await openNeon();
    expect(screen.getByTestId('cast-toggle')).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByTestId('cast-toggle'));
    // Ambient hides the toolbar entirely; the exit affordance is the only chrome.
    expect(await screen.findByTestId('cast-exit')).toBeInTheDocument();
    expect(screen.queryByTestId('cast-toggle')).toBeNull();
    expect(screen.queryByTestId('viewer-settings-toggle')).toBeNull();
  });
});
