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
// The mock host is deliberately absent: the bridge cannot run in this tier
// (browser specs execute inside an iframe whose parent is the test runner —
// see ContinuousView.browser.test.tsx's header), and nothing here asserts
// bridge behaviour.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { CivitaiReaction } from '@civitai/components-react/elements/civitai-reaction';

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
