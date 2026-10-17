// 🔴 THE ELEMENT HALF OF THE REACTION CONTRACT, AND IT CAN ONLY LIVE IN THE
// BROWSER TIER.
//
// The app's side of the contract — event in, bridge calls out, errors mapped,
// retries stashed — is asserted in `reactions.test.tsx` (jsdom) against the
// real `useReactions` and the SDK mock host. What jsdom structurally cannot
// assert is the ELEMENT side: vitest resolves `@lit/react` to its SSR build
// there (the `node` export condition), where the binding's property
// assignment is compiled out, so a bound `<civitai-reaction>` keeps default
// props in jsdom no matter what the app passes. Asserting "count renders 7"
// in that tier would be FALSE there even with the code correct — the exact
// trap this tier exists for (see vite.config.ts's browser-project comment).
//
// So this file pins, in a real engine, the three things the app's design
// rests on:
//   1. props passed the way CollectionViewer passes them LAND (properties,
//      pressed state, count text);
//   2. a click dispatches `react` with `detail.reaction` set and
//      `detail.reacted` = the NEW desired state (set semantics' input);
//   3. REBINDING IS THE REVERT: after the element flips itself optimistically,
//      setting the props back to the truth un-flips it — the mechanism the
//      hook's failure path relies on, with no app-side state involved;
//   4. the `pc-reaction-unknown` class hides the count part via the app's
//      own stylesheet (the `statsUnknown` rendering rule).
//
// The mock host is deliberately absent FROM THE ELEMENT TESTS: nothing in
// the first describe asserts bridge behaviour. The LAST describe is the one
// exception, and it earns it: the round-2 audit pinned a behaviour — the
// app's reset of a self-flipped element after an ungranted tap — that
// exists only in the mounted viewer, so the viewer is mounted here, with
// the mock host installed so its host-coupled hooks have a host. Two
// things make that mountable in this tier when an earlier attempt (see
// ContinuousView.browser.test.tsx's header) hung: the transport is
// initialised with the page origin BEFORE any hook constructs it
// (`resetHarnessTransport`, the jsdom tier's own ordering), and
// `@civitai/blocks-react` is excluded from this project's dep optimizer
// (vite.config.ts), so the viewer's SDK components share the one React
// instead of dying on a second copy's null dispatcher. Nothing in that
// describe asserts bridge traffic — the ungranted path by construction
// sends none; what it asserts is the element's pressed state after a REAL
// click, which is the thing jsdom cannot flip.

import { useState, type ReactElement } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { createMockHost } from '@civitai/blocks-react/testing';
import { CivitaiReaction } from '@civitai/components-react/elements/civitai-reaction';

import { CollectionViewer } from './CollectionViewer.js';
import { resetHarnessTransport } from '../dev-transport.js';
import { palette } from '../theme.js';
import type { CollectionDetail, MediaItem } from '../types.js';

import '../index.css';

afterEach(cleanup);

type ReactionEl = HTMLElement & {
  updateComplete: Promise<unknown>;
  reaction?: string;
  count?: number;
  reacted?: boolean;
};

function shadowButton(el: ReactionEl): HTMLButtonElement {
  const btn = el.shadowRoot?.querySelector('button');
  if (!btn) throw new Error('no shadow button');
  return btn;
}

function countSpan(el: ReactionEl): HTMLElement {
  const span = el.shadowRoot?.querySelector('[part~="count"]');
  if (!span) throw new Error('no count part');
  return span as HTMLElement;
}

describe('<civitai-reaction> — the element contract the player binds to', () => {
  it('props land: pressed state, emoji and count render from them', async () => {
    const { container } = render(
      <CivitaiReaction reaction="Heart" emoji="❤️" count={12} label="Heart" reacted />,
    );
    const el = container.querySelector('civitai-reaction') as ReactionEl;
    await el.updateComplete;
    expect(el.reaction).toBe('Heart');
    expect(el.count).toBe(12);
    expect(el.reacted).toBe(true);
    const btn = shadowButton(el);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toContain('❤️');
    expect(countSpan(el).textContent).toBe('12');
  });

  it('a click dispatches react with the reaction name and the NEW desired state', async () => {
    const { container } = render(<CivitaiReaction reaction="Like" emoji="👍" count={7} label="Like" />);
    const el = container.querySelector('civitai-reaction') as ReactionEl;
    await el.updateComplete;
    const seen: unknown[] = [];
    el.addEventListener('react', (e) => seen.push((e as CustomEvent).detail));
    shadowButton(el).click();
    await el.updateComplete;
    expect(seen).toEqual([{ emoji: '👍', reacted: true, count: 8, reaction: 'Like' }]);
    // …and the element has flipped ITSELF optimistically.
    expect(shadowButton(el).getAttribute('aria-pressed')).toBe('true');
  });

  it('rebinding the truth over the optimistic flip reverts the element', async () => {
    const { container, rerender } = render(
      <CivitaiReaction reaction="Like" emoji="👍" count={7} label="Like" />,
    );
    const el = container.querySelector('civitai-reaction') as ReactionEl;
    await el.updateComplete;
    shadowButton(el).click();
    await el.updateComplete;
    expect(shadowButton(el).getAttribute('aria-pressed')).toBe('true');
    expect(countSpan(el).textContent).toBe('8');

    // The write failed; the app re-renders with byId's truth (unchanged) —
    // `reacted` passed explicitly as a boolean, exactly as CollectionViewer
    // binds it (`viewerReactions.includes(...)`). The property diff is what
    // carries the revert — no event, no reset API.
    rerender(<CivitaiReaction reaction="Like" emoji="👍" count={7} label="Like" reacted={false} />);
    await el.updateComplete;
    expect(el.reacted).toBe(false);
    expect(shadowButton(el).getAttribute('aria-pressed')).toBe('false');
    expect(countSpan(el).textContent).toBe('7');
  });

  it('the pc-reaction-unknown class hides the count part (statsUnknown)', async () => {
    const { container } = render(
      <CivitaiReaction reaction="Like" emoji="👍" count={0} label="Like" className="pc-reaction-unknown" />,
    );
    const el = container.querySelector('civitai-reaction') as ReactionEl;
    await el.updateComplete;
    expect(getComputedStyle(countSpan(el)).display).toBe('none');

    const plain = render(<CivitaiReaction reaction="Like" emoji="👍" count={5} label="Like" />);
    const el2 = plain.container.querySelector('civitai-reaction') as ReactionEl;
    await el2.updateComplete;
    expect(getComputedStyle(countSpan(el2)).display).not.toBe('none');
  });

  it('disabled lands on the shadow button', async () => {
    const { container } = render(<CivitaiReaction reaction="Cry" emoji="😢" count={1} label="Cry" disabled />);
    const el = container.querySelector('civitai-reaction') as ReactionEl;
    await el.updateComplete;
    expect(shadowButton(el).disabled).toBe(true);
  });
});

// ============================================================================
// THE UNGRANTED RESET, IN THE MOUNTED VIEWER (round-2 audit).
//
// The jsdom tier's `fireReact` dispatches the `react` event SYNTHETICALLY —
// the element never flips, so the app's reset of the flipped element after
// an ungranted tap (`el.reacted = false` in CollectionViewer's `onReact`)
// is exercised there against an element that was never pressed: replace
// the reset with a no-op and the whole jsdom suite stays green. Here the
// click is REAL: the element flips itself (proven by the second test in
// the describe above), the app's delegated listener hears the event, and
// the element must end unpressed. WHICH mechanism earns that turns out to
// be path-dependent — binding re-assignment on the re-render the stash
// causes, vs the explicit reset where no re-render follows — and the
// second test below is the one that pins the reset itself.
// ============================================================================

const viewerDetail: CollectionDetail = {
  id: 7,
  name: 'Reaction browser fixture',
  description: null,
  curator: { userId: 55, username: 'curator' },
  isPublic: true,
  followed: false,
};

const viewerItem = (mediaId: number, ticketed = true): MediaItem => ({
  mediaId,
  type: 'image',
  url: `https://example.test/img/${mediaId}.jpg`,
  width: 640,
  height: 640,
  creator: { userId: 22, username: 'bob' },
  nsfwLevel: 1,
  ...(ticketed ? { reactTicket: `ticket-${mediaId}` } : {}),
});

/** The viewer mounted the way the jsdom tier's Host mounts it, minus the
 *  seams the browser cannot offer (no per-test storage stub — the real
 *  localStorage of a fresh browser profile is empty, which is the state
 *  being rendered anyway). */
function ViewerHost(p: { onRequestReactConsent: () => void; ticketed?: boolean }): ReactElement {
  const [followed, setFollowed] = useState(false);
  const [splitPlans, setSplitPlans] = useState<Readonly<Record<string, never[]>>>({});
  return (
    <CollectionViewer
      detail={viewerDetail}
      items={[viewerItem(2001, p.ticketed ?? true)]}
      viewerUserId={99}
      buzzBalance={null}
      followed={followed}
      onFollowChange={(_id, next) => setFollowed(next)}
      settings={{ secondsPerImage: 600, videoLoopCount: 1 }}
      onSecondsPerImageChange={() => {}}
      onVideoLoopCountChange={() => {}}
      storage={window.localStorage}
      reducedMotion
      c={palette()}
      onExit={() => {}}
      onTip={async () => true}
      tipping={false}
      splitPlans={splitPlans}
      onSplitPlanChange={(key, plan) =>
        setSplitPlans((prev) => {
          const next = { ...prev } as Record<string, never[]>;
          if (plan == null) delete next[key];
          else next[key] = plan as never[];
          return next;
        })
      }
      isMobile={false}
      hasReactScope={false}
      reactTokenEpoch="epoch-1"
      onRequestReactConsent={p.onRequestReactConsent}
      onReactionNotice={() => {}}
    />
  );
}

describe('<civitai-reaction> — the ungranted reset in the mounted viewer', () => {
  it('an ungranted REAL click leaves aria-pressed false — the app resets the self-flipped element', async () => {
    resetHarnessTransport();
    const host = createMockHost({
      viewer: { id: 99, username: 'me' },
      declaredScopes: ['social:react:self'],
      reactionStates: { 2001: { counts: { Like: 5 } } },
    });
    const uninstall = host.install();
    const onRequestReactConsent = vi.fn();
    try {
      render(<ViewerHost onRequestReactConsent={onRequestReactConsent} />);
      await screen.findByTestId('viewer-reactions', {}, { timeout: 8000 });
      const el = screen.getByTestId('reaction-like') as unknown as ReactionEl;
      await el.updateComplete;
      const btn = shadowButton(el);
      expect(btn.getAttribute('aria-pressed')).toBe('false');

      // A REAL click on the shadow button: the element flips itself to
      // pressed and dispatches `react` (the two element tests above pin
      // both halves). The ungranted path then holds the intent and asks
      // for consent — and must leave NO pressed state behind, because the
      // binding cannot repair it (the ungranted bound value is `false`
      // before and after, so no property diff ever re-renders it away).
      btn.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // The tap really happened (the consent ask is the app's receipt for
      // it) — and the element is unpressed again.
      expect(onRequestReactConsent).toHaveBeenCalledTimes(1);
      expect(el.reacted).toBe(false);
      expect(btn.getAttribute('aria-pressed')).toBe('false');
    } finally {
      uninstall();
    }
  }, 20000);

  it('a TICKETLESS ungranted click also leaves aria-pressed false — the path where ONLY the reset can repair it', async () => {
    resetHarnessTransport();
    const host = createMockHost({
      viewer: { id: 99, username: 'me' },
      declaredScopes: ['social:react:self'],
      reactionStates: { 2001: { counts: { Like: 5 } } },
    });
    const uninstall = host.install();
    const onRequestReactConsent = vi.fn();
    try {
      render(<ViewerHost onRequestReactConsent={onRequestReactConsent} ticketed={false} />);
      await screen.findByTestId('viewer-reactions', {}, { timeout: 8000 });
      const el = screen.getByTestId('reaction-like') as unknown as ReactionEl;
      await el.updateComplete;
      const btn = shadowButton(el);
      expect(btn.getAttribute('aria-pressed')).toBe('false');

      // 🔴 WHY THIS TEST IS THE RESET'S PIN, AND THE ONE ABOVE IS NOT.
      // `@lit/react`'s real build re-assigns every bound property on every
      // commit (its layout effect carries no dependency array), so on the
      // TICKETED path the re-render a stash causes (the held-tap pause
      // state) re-applies `reacted={false}` through the binding and would
      // mask a missing reset. A ticketless tap takes the no-op branch: it
      // stashes nothing, asks nothing, and changes no state — no re-render
      // follows, no binding re-assignment happens, and the app's explicit
      // `el.reacted = false` is the ONLY thing between the element's
      // self-flip and a permanently pressed button. No-op that line and
      // THIS test goes red while the ticketed one above stays green —
      // that asymmetry is the evidence, and it is why the reset is written
      // in the handler instead of being left to the binding.
      btn.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // The tap was a no-op (nothing to ask FOR — the write could never be
      // sent), and the element is still reset.
      expect(onRequestReactConsent).not.toHaveBeenCalled();
      expect(el.reacted).toBe(false);
      expect(btn.getAttribute('aria-pressed')).toBe('false');
    } finally {
      uninstall();
    }
  }, 20000);
});
