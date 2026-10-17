import { useState, type ReactElement } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockHost, type MockHost, type MockHostOptions } from '@civitai/blocks-react/testing';

import { CollectionViewer } from './CollectionViewer.js';
import { palette } from '../theme.js';
import type { CollectionDetail, MediaItem } from '../types.js';
import type { PlayerSettings } from '../settings.js';

// ============================================================================
// 🔴 REACTIONS, DRIVEN AT THE BRIDGE — the same level as every other social
// behaviour in this suite. The REAL `useReactions` (no module mock, no seam
// in the component) talks to the SDK's mock host, which enforces the live
// contract: declaration gate, ticket presence, set semantics, forced error
// codes, and state that persists across writes. A double that skipped any of
// that would let the wiring ship unexercised — the failure this repo keeps
// re-learning (see fake-api.test.ts's header).
//
// 🔴 WHAT jsdom CANNOT SEE, AND WHERE IT IS ASSERTED INSTEAD. Vitest resolves
// `@lit/react` to its SSR build (the `node` export condition), where the
// property assignment the `@civitai/components-react` bindings exist to do
// is compiled out — so in this tier a bound `<civitai-reaction>` keeps its
// default props no matter what the app passes, and its shadow button cannot
// be clicked into dispatching a meaningful `react` event. That is a
// property of the resolver, not of the code (proven by probe: the same
// binding sets props correctly from a raw tag and in the real browser).
// So here, a reaction tap is delivered as the element's DOCUMENTED OUTPUT —
// a `react` CustomEvent with `{ reaction, reacted }` detail, dispatched on
// the element host — and everything downstream of that event (the wire, the
// error mapping, the retries, the read economy) is asserted for real. The
// element half of the contract (props land, pressed/count render, a click
// dispatches exactly that event, rebinding reverts it) is asserted in
// `reactions.browser.test.tsx`, and the full loop in the dev harness.
//
// What the mock host also cannot produce, and this file therefore does not
// fake: a TRANSPORT TIMEOUT (its fail modes all reply immediately; there is
// no drop-the-reply knob), so `toggle`'s `.timedOut` mapping is covered by
// inspection alongside the sibling refusal mappings proven here, not by a
// test that pretends otherwise.
// ============================================================================

const VIEWER_ID = 99;
const c = palette();

/** Fresh in-memory Storage (tip-affordance.test.tsx's shape). */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const detail: CollectionDetail = {
  id: 7,
  name: 'Reaction fixture',
  description: null,
  curator: { userId: 55, username: 'curator' },
  isPublic: true,
  followed: false,
};

const item = (mediaId: number, ticketed = true): MediaItem => ({
  mediaId,
  type: 'image',
  url: `https://example.test/img/${mediaId}.jpg`,
  width: 640,
  height: 640,
  creator: { userId: 22, username: 'bob' },
  nsfwLevel: 1,
  ...(ticketed ? { reactTicket: `ticket-${mediaId}` } : {}),
});

const SETTINGS: PlayerSettings = { secondsPerImage: 600, videoLoopCount: 1 };

interface HostProps {
  items: MediaItem[];
  hasReactScope?: boolean;
  reactTokenEpoch?: string;
  onRequestReactConsent?: () => void;
  onReactionNotice?: (kind: 'error' | 'info', message: string) => void;
  onRefreshItems?: () => Promise<readonly MediaItem[] | null>;
}

/** The viewer mounted the way tip-affordance.test.tsx mounts it (bare, no
 *  host wrapper of its own) — the bridge host is installed around it. */
function Host(p: HostProps): ReactElement {
  const [followed, setFollowed] = useState(false);
  const [splitPlans, setSplitPlans] = useState<Readonly<Record<string, never[]>>>({});
  return (
    <CollectionViewer
      detail={detail}
      items={p.items}
      viewerUserId={VIEWER_ID}
      buzzBalance={null}
      followed={followed}
      onFollowChange={(_id, next) => setFollowed(next)}
      settings={SETTINGS}
      onSecondsPerImageChange={() => {}}
      onVideoLoopCountChange={() => {}}
      storage={memStorage()}
      reducedMotion
      c={c}
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
      hasReactScope={p.hasReactScope ?? true}
      reactTokenEpoch={p.reactTokenEpoch}
      onRequestReactConsent={p.onRequestReactConsent}
      onReactionNotice={p.onReactionNotice}
      onRefreshItems={p.onRefreshItems}
    />
  );
}

// ---- bridge observation ----

interface OutboundMsg {
  type: string;
  payload?: unknown;
}
let outbound: OutboundMsg[] = [];
const reads = () => outbound.filter((m) => m.type === 'GET_ENTITY_REACTIONS');
const writes = () =>
  outbound.filter((m) => m.type === 'SET_ENTITY_REACTION') as {
    payload: { entityId: number; reaction: string; reacted: boolean; ticket?: string };
  }[];

let host: MockHost | null = null;
let uninstall: (() => void) | null = null;

function installHost(opts: MockHostOptions = {}): MockHost {
  outbound = [];
  host = createMockHost({
    viewer: { id: VIEWER_ID, username: 'me' },
    declaredScopes: ['social:react:self'],
    onOutbound: (m) => outbound.push(m),
    ...opts,
  });
  uninstall = host.install();
  return host;
}

beforeEach(() => {
  outbound = [];
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  host = null;
});

// ---- the element's output, delivered as documented ----

const EMOJI: Record<string, string> = { like: '👍', heart: '❤️', laugh: '😂', cry: '😢' };
const NAME: Record<string, string> = { like: 'Like', heart: 'Heart', laugh: 'Laugh', cry: 'Cry' };

/**
 * Fire the `react` event exactly as the element dispatches it on a tap: it
 * has ALREADY flipped itself, so `detail.reacted` is the state the tap asks
 * for. (`count` in the detail is the element's own optimistic number and is
 * deliberately junk here — the app must not read it; the hook's `byId` is
 * the only count source.)
 */
function fireReact(name: 'like' | 'heart' | 'laugh' | 'cry', reacted: boolean): void {
  const el = screen.getByTestId(`reaction-${name}`);
  fireEvent(
    el,
    new CustomEvent('react', {
      bubbles: true,
      composed: true,
      detail: { emoji: EMOJI[name], reacted, count: 999, reaction: NAME[name] },
    }),
  );
}

describe('reactions — gate and binding', () => {
  it('gate OFF: no reaction UI and no reaction reads are issued', async () => {
    installHost({ reactionStates: { 2001: { counts: { Like: 5 } } } });
    render(<Host items={[item(2001)]} hasReactScope={false} />);
    // The row (Follow/Tip) proves the viewer mounted and reported its item.
    await screen.findByTestId('chrome-tip');
    expect(screen.queryByTestId('viewer-reactions')).toBeNull();
    expect(reads()).toHaveLength(0);
  });

  it('reads once, with the item’s ticket on the wire, and renders all four toggles', async () => {
    installHost({
      reactionStates: {
        2001: { counts: { Like: 7, Heart: 3, Laugh: 0, Cry: 1 }, viewerReactions: ['Heart'] },
      },
    });
    render(<Host items={[item(2001)]} />);
    // The group renders only once the read has ANSWERED for the current item
    // (an unanswered id renders nothing — see the unavailable test).
    await screen.findByTestId('viewer-reactions');
    for (const name of ['like', 'heart', 'laugh', 'cry']) {
      expect(screen.getByTestId(`reaction-${name}`)).toBeTruthy();
    }
    expect(reads()).toHaveLength(1);
    expect((reads()[0].payload as { tickets: Record<string, string> }).tickets).toEqual({
      '2001': 'ticket-2001',
    });
    expect((reads()[0].payload as { ids: number[] }).ids).toEqual([2001]);
  });

  it('an item without a ticket gets NO reaction UI (unavailable, by design)', async () => {
    installHost({ reactionStates: { 2002: { counts: { Like: 9 } } } });
    render(<Host items={[item(2001), item(2002, false)]} />);
    await screen.findByTestId('viewer-reactions'); // item 2001 has state
    fireEvent.click(screen.getByTestId('ctrl-next'));
    // The progress label proves navigation landed on item 2…
    await waitFor(() => expect(screen.getByTestId('progress-label').textContent).toContain('2'));
    // …and item 2 — ticketless, so the host lists it `unavailable` — renders
    // no controls rather than an assumed "not reacted" state.
    expect(screen.queryByTestId('viewer-reactions')).toBeNull();
  });

  it('statsUnknown: the toggles render, stamped with the count-hiding class', async () => {
    installHost({
      reactionStates: {
        2001: { counts: { Like: 42 }, viewerReactions: ['Like'], statsUnknown: true },
      },
    });
    render(<Host items={[item(2001)]} />);
    await screen.findByTestId('viewer-reactions');
    // The class is the app's half of "render WITHOUT counts" (the ::part
    // rule that consumes it is asserted in the browser tier, where CSS
    // exists). The toggles themselves stay present and live.
    await waitFor(() =>
      expect(screen.getByTestId('reaction-like').classList.contains('pc-reaction-unknown')).toBe(true),
    );
    expect(screen.getByTestId('reaction-heart').classList.contains('pc-reaction-unknown')).toBe(true);
  });

  it('a statsKnown item carries NO count-hiding class', async () => {
    installHost({ reactionStates: { 2001: { counts: { Like: 42 } } } });
    render(<Host items={[item(2001)]} />);
    await screen.findByTestId('viewer-reactions');
    expect(screen.getByTestId('reaction-like').classList.contains('pc-reaction-unknown')).toBe(false);
  });
});

describe('reactions — toggling', () => {
  it('a tap sends (id, reaction, reacted) with set semantics, both ways', async () => {
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    render(<Host items={[item(2001)]} />);
    await screen.findByTestId('viewer-reactions');

    fireReact('like', true);
    await waitFor(() => expect(writes()).toHaveLength(1));
    // The whole payload, bar the transport's request id: set semantics are
    // the `reacted: true` (a state to reach, not a flip to apply), and the
    // ticket is the item's own.
    const { requestId: _req, ...writePayload } = writes()[0].payload as Record<string, unknown>;
    expect(writePayload).toEqual({
      entityType: 'image',
      entityId: 2001,
      reaction: 'Like',
      reacted: true,
      ticket: 'ticket-2001',
    });

    fireReact('like', false);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].payload).toMatchObject({ entityId: 2001, reaction: 'Like', reacted: false });
  });

  it('the reaction is taken from detail.reaction — an unnamed event is ignored', async () => {
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    render(<Host items={[item(2001)]} />);
    await screen.findByTestId('viewer-reactions');
    // No `reaction` in the detail (an element rendered without the prop):
    // the emoji must NOT be reverse-mapped into a reaction.
    fireEvent(
      screen.getByTestId('reaction-like'),
      new CustomEvent('react', { bubbles: true, composed: true, detail: { emoji: '👍', reacted: true, count: 8 } }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
  });

  it('a double-fire racing the pending write is a SILENT no-op (busy)', async () => {
    const notice = vi.fn();
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    render(<Host items={[item(2001)]} onReactionNotice={notice} />);
    await screen.findByTestId('viewer-reactions');

    // Two dispatches back-to-back: the second `toggle` call reaches the hook
    // while the first write is still in flight → `busy` → swallowed.
    fireReact('like', true);
    fireReact('like', true);
    await waitFor(() => expect(writes()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
    expect(notice).not.toHaveBeenCalled();
  });

  it('navigation does NOT re-read: the window is read once, the hook persists', async () => {
    installHost({
      reactionStates: {
        2001: { counts: { Like: 1 } },
        2002: { counts: { Like: 2 } },
        2003: { counts: { Like: 3 } },
      },
    });
    render(<Host items={[item(2001), item(2002), item(2003)]} />);
    await screen.findByTestId('viewer-reactions');
    await waitFor(() => expect(reads()).toHaveLength(1));

    fireEvent.click(screen.getByTestId('ctrl-next'));
    await waitFor(() => expect(screen.getByTestId('progress-label').textContent).toContain('2'));
    fireEvent.click(screen.getByTestId('ctrl-next'));
    await waitFor(() => expect(screen.getByTestId('progress-label').textContent).toContain('3'));
    // Two navigations later: still exactly one read, because every id was
    // in the window and neither an id nor a ticket changed. A remount-per-
    // item hook (or a fresh read per item) would show three.
    expect(reads()).toHaveLength(1);
    expect(screen.getByTestId('viewer-reactions')).toBeTruthy();
  });
});

describe('reactions — refusals', () => {
  it('needs-consent: asks once, toasts nothing, and retries once on a fresh token', async () => {
    const onRequestReactConsent = vi.fn();
    const notice = vi.fn();
    const h = installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const { rerender } = render(
      <Host items={[item(2001)]} reactTokenEpoch="epoch-1" onRequestReactConsent={onRequestReactConsent} onReactionNotice={notice} />,
    );
    await screen.findByTestId('viewer-reactions');

    // The grant lapsed after the mint: the host now refuses writes.
    h.setScenario({ reactionError: 'needs-consent' });
    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));
    expect(notice).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);

    // The viewer grants → the host re-mints (epoch flips) → the stash retries.
    h.setScenario({ reactionError: null });
    rerender(
      <Host items={[item(2001)]} reactTokenEpoch="epoch-2" onRequestReactConsent={onRequestReactConsent} onReactionNotice={notice} />,
    );
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].payload).toMatchObject({ entityId: 2001, reaction: 'Like', reacted: true });
    expect(onRequestReactConsent).toHaveBeenCalledTimes(1);
    expect(notice).not.toHaveBeenCalled();
  });

  it('a refusal that persists past the retry ends in an honest toast', async () => {
    const notice = vi.fn();
    const h = installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const { rerender } = render(<Host items={[item(2001)]} reactTokenEpoch="epoch-1" onReactionNotice={notice} />);
    await screen.findByTestId('viewer-reactions');

    h.setScenario({ reactionError: 'needs-consent' });
    fireReact('like', true);
    await waitFor(() => expect(writes()).toHaveLength(1));
    // Fresh token, SAME fight (the retried write is refused too, with a
    // terminal code this time): the viewer is told, once, honestly.
    h.setScenario({ reactionError: 'rate-limited' });
    rerender(<Host items={[item(2001)]} reactTokenEpoch="epoch-2" onReactionNotice={notice} />);
    await waitFor(() => expect(notice).toHaveBeenCalled());
    expect(notice).toHaveBeenCalledWith('error', expect.stringContaining('reacting too quickly'));
    expect(writes()).toHaveLength(2);
  });

  it('sign-in-required: prompts sign-in via toast', async () => {
    const notice = vi.fn();
    const h = installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    render(<Host items={[item(2001)]} onReactionNotice={notice} />);
    await screen.findByTestId('viewer-reactions');

    h.setScenario({ reactionError: 'sign-in-required' });
    fireReact('like', true);
    await waitFor(() => expect(notice).toHaveBeenCalledWith('error', expect.stringContaining('Sign in to react')));
    expect(writes()).toHaveLength(1);
  });

  it('an expired ticket: ONE refetch, ONE retry, and the retry carries the fresh ticket', async () => {
    const notice = vi.fn();
    const h = installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const stale = { ...item(2001), reactTicket: 'ticket-STALE' };
    const fresh = { ...item(2001), reactTicket: 'ticket-FRESH' };
    const onRefreshItems = vi.fn(async () => {
      // The refetch answers with a fresh ticket; the host accepts writes
      // again (the refusal WAS the stale ticket).
      h.setScenario({ reactionError: null });
      return [fresh] as readonly MediaItem[];
    });
    const { rerender } = render(<Host items={[stale]} onRefreshItems={onRefreshItems} onReactionNotice={notice} />);
    await screen.findByTestId('viewer-reactions');

    h.setScenario({ reactionError: 'entity-unavailable' });
    fireReact('like', true);
    // The refusal triggered exactly one refetch…
    await waitFor(() => expect(onRefreshItems).toHaveBeenCalledTimes(1));
    // …and once App hands the refreshed items down, exactly one retry, and
    // it went out under the FRESH ticket.
    rerender(<Host items={[fresh]} onRefreshItems={onRefreshItems} onReactionNotice={notice} />);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[0].payload.ticket).toBe('ticket-STALE');
    expect(writes()[1].payload.ticket).toBe('ticket-FRESH');
    expect(notice).not.toHaveBeenCalled();
  });

  it('entity-unavailable with NO fresh ticket after refetch: honest toast, no retry', async () => {
    const notice = vi.fn();
    const h = installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const onRefreshItems = vi.fn(async () => null);
    render(<Host items={[item(2001)]} onRefreshItems={onRefreshItems} onReactionNotice={notice} />);
    await screen.findByTestId('viewer-reactions');

    h.setScenario({ reactionError: 'entity-unavailable' });
    fireReact('like', true);
    await waitFor(() => expect(notice).toHaveBeenCalledWith('error', expect.stringContaining('not available')));
    expect(onRefreshItems).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(1);
  });
});
