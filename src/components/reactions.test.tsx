import { useState, type ReactElement } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockHost, type MockHost, type MockHostOptions } from '@civitai/blocks-react/testing';

import { CollectionViewer } from './CollectionViewer.js';
import { palette } from '../theme.js';
import type { CollectionDetail, MediaItem } from '../types.js';
import type { PlayerSettings } from '../settings.js';
import type { ViewMode } from '../view-modes.js';

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
  viewerUserId?: number | null;
  onRequestReactConsent?: () => void;
  onReactionNotice?: (kind: 'error' | 'info', message: string) => void;
  /** Defaults to the suite-wide 600s pin; the fast-pacing test overrides
   *  it — at 600s auto-advance can never fire inside a test, which is
   *  exactly the blind spot the round-2 audit's probe (1s pacing) found. */
  settings?: PlayerSettings;
  /** Mount straight into a surface (the lightbox and continuous pins). */
  initialMode?: ViewMode;
  /** Defaults to true (the viewer's own pin); the continuous-drift pin
   *  needs it false — reduced motion is an independent auto-scroll gate,
   *  and leaving it on would make that test pass with the pause unwired. */
  reducedMotion?: boolean;
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
      viewerUserId={p.viewerUserId === undefined ? VIEWER_ID : p.viewerUserId}
      buzzBalance={null}
      followed={followed}
      onFollowChange={(_id, next) => setFollowed(next)}
      settings={p.settings ?? SETTINGS}
      onSecondsPerImageChange={() => {}}
      onVideoLoopCountChange={() => {}}
      storage={memStorage()}
      initialMode={p.initialMode}
      reducedMotion={p.reducedMotion ?? true}
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
  it('ungranted signed-in: the buttons render count-less and NO read is sent', async () => {
    installHost({ reactionStates: { 2001: { counts: { Like: 5 } } } });
    render(<Host items={[item(2001)]} hasReactScope={false} />);
    // The tips pattern: the surface EXISTS for a signed-in viewer who has
    // not granted — all four elements, with the counts hidden (the app
    // holds no counts to show: the count-less class is the marker here,
    // the ::part rule it drives is asserted in the browser tier).
    await screen.findByTestId('viewer-reactions');
    for (const name of ['like', 'heart', 'laugh', 'cry']) {
      const el = screen.getByTestId(`reaction-${name}`);
      expect(el.classList.contains('pc-reaction-unknown')).toBe(true);
    }
    // …and the hook's inputs stay empty, so no read is EVER sent for this
    // viewer: a read without the grant would be refused AND billed.
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('anonymous: no reaction UI at all — there is no grant to ask for', async () => {
    installHost({ reactionStates: { 2001: { counts: { Like: 5 } } } });
    render(<Host items={[item(2001)]} hasReactScope={false} viewerUserId={null} />);
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

  it('entity-unavailable: the honest toast, exactly one write, no refetch and no retry', async () => {
    const notice = vi.fn();
    const h = installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    render(<Host items={[item(2001)]} onReactionNotice={notice} />);
    await screen.findByTestId('viewer-reactions');

    h.setScenario({ reactionError: 'entity-unavailable' });
    fireReact('like', true);
    await waitFor(() => expect(notice).toHaveBeenCalledWith('error', expect.stringContaining('not available')));
    // The toast stands alone: the write that was refused is the only one
    // ever sent. (The deleted refetch-and-retry loop is why this asserts a
    // count at all: a ticket's per-second expiry made every refetch look
    // "fresh", so the retry could never be told apart from a loop.)
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
    expect(reads()).toHaveLength(1); // the mount read; no refetch traffic
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('needs-consent refused AFTER navigation: the late stash is refused too — a later grant sends nothing more', async () => {
    const onRequestReactConsent = vi.fn();
    const notice = vi.fn();
    const h = installHost({
      reactionStates: { 2001: { counts: { Like: 7 } }, 2002: { counts: { Like: 1 } } },
    });
    const { rerender } = render(
      <Host
        items={[item(2001), item(2002)]}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
        onReactionNotice={notice}
      />,
    );
    await screen.findByTestId('viewer-reactions');

    h.setScenario({ reactionError: 'needs-consent' });
    // 🔴 THE ROUND-3 PATH, EXACTLY. A GRANTED viewer taps Like on item
    // 2001; the write goes out — and its refusal can only be processed
    // when this synchronous stretch yields (the toggle's rejection is a
    // promise continuation), so the navigation below lands FIRST, while
    // the write is still in flight. NOTHING MAY BE AWAITED between the
    // tap and the click: that synchrony is the test. At the pre-fix code
    // the refusal then stashed 2001's tap under item 2002, and the grant
    // below fired it — writes [2001, 2001] with `2 / 2` on screen.
    fireReact('like', true);
    fireEvent.click(screen.getByTestId('ctrl-next'));
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2'));

    // The refusal settles now, against an item no longer on screen. The
    // navigation drop could not catch it (nothing was stashed at
    // navigation time); the stash's own entry guard refuses it instead —
    // so nothing is held, and nothing is ASKED either: a consent dialog
    // for a dead tap would grant a scope whose held purpose is gone.
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1); // the refused original, and only it
    expect(onRequestReactConsent).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();

    // The grant lands anyway (any later consent re-mints carrying the
    // scope): there is no stash to fire, so the write count for 2001
    // stays at the one refused attempt. Remove the stash-entry guard and
    // this is where the second write appears.
    h.setScenario({ reactionError: null });
    rerender(
      <Host
        items={[item(2001), item(2002)]}
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
        onReactionNotice={notice}
      />,
    );
    await waitFor(() => expect(reads().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
    expect(writes()[0].payload).toMatchObject({ entityId: 2001, reaction: 'Like', reacted: true });
    expect(onRequestReactConsent).not.toHaveBeenCalled();
  });
});

describe('reactions — the ungranted consent path (show the buttons, ask on press)', () => {
  it('a tap asks for consent — and sends no write before it', async () => {
    const onRequestReactConsent = vi.fn();
    const notice = vi.fn();
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    render(
      <Host
        items={[item(2001)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
        onReactionNotice={notice}
      />,
    );
    await screen.findByTestId('viewer-reactions');

    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));
    // The tap went to the consent ask, NOT the bridge: no write, no read,
    // no toast (the host's consent UI is the surface now).
    expect(writes()).toHaveLength(0);
    expect(reads()).toHaveLength(0);
    expect(notice).not.toHaveBeenCalled();
  });

  it('after the grant lands, the stashed tap is sent exactly once', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const { rerender } = render(
      <Host
        items={[item(2001)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    fireReact('heart', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(0);

    // The grant lands: the host re-mints (epoch flips, scope now carried).
    rerender(
      <Host items={[item(2001)]} hasReactScope reactTokenEpoch="epoch-2" onRequestReactConsent={onRequestReactConsent} />,
    );
    // The ONE held tap goes out, under the item's ticket, with set
    // semantics — not zero times (lost) and not two (double-applied).
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].payload).toMatchObject({
      entityId: 2001,
      reaction: 'Heart',
      reacted: true,
      ticket: 'ticket-2001',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
    expect(onRequestReactConsent).toHaveBeenCalledTimes(1);
  });

  it('a decline produces NO new token: nothing fires, nothing toasts', async () => {
    const onRequestReactConsent = vi.fn();
    const notice = vi.fn();
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    render(
      <Host
        items={[item(2001)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
        onReactionNotice={notice}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));

    // 🔴 THE DECLINE, MODELLED AS THE REAL HOST DOES IT (round-1 audit):
    // on "Not now" the host only closes the dialog — it NEVER re-mints, so
    // there is no epoch-2 render in this test because there is no epoch-2
    // TOKEN. The held tap just sits there (its death is item change or
    // expiry — the next two tests); what the decline itself must never do
    // is fire it or report it.
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
    expect(reads()).toHaveLength(0);
    expect(notice).not.toHaveBeenCalled();
  });

  it('a fresh token WITHOUT the scope settles the held tap — dropped, and a later grant does not revive it', async () => {
    const onRequestReactConsent = vi.fn();
    const notice = vi.fn();
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const { rerender } = render(
      <Host
        items={[item(2001)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
        onReactionNotice={notice}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));

    // A re-mint for some OTHER cause (NOT a decline — a decline mints
    // nothing, see the test above): a fresh token whose scopes still lack
    // the scope. The held tap is settled by that mint — dropped, not kept.
    rerender(
      <Host
        items={[item(2001)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
        onReactionNotice={notice}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
    expect(notice).not.toHaveBeenCalled();

    // Proof the stash is empty rather than dormant: when the grant DOES
    // land later, the settled tap does not ride it. (Reads now flow —
    // that is the granted state working, not the stale intent.)
    rerender(
      <Host items={[item(2001)]} hasReactScope reactTokenEpoch="epoch-3" onRequestReactConsent={onRequestReactConsent} />,
    );
    await waitFor(() => expect(reads()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
  });

  it('decline → navigate → a later grant sends nothing: the held tap died with its item', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({
      reactionStates: { 2001: { counts: { Like: 7 } }, 2002: { counts: { Like: 1 } } },
    });
    const { rerender } = render(
      <Host
        items={[item(2001), item(2002)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(0);

    // Declined (no new token — nothing to rerender), then the viewer moves
    // on to item 2002. The held tap was made ON 2001; navigation drops it.
    fireEvent.click(screen.getByTestId('ctrl-next'));
    await waitFor(() => expect(screen.getByTestId('progress-label').textContent).toContain('2'));

    // A later grant — from ANY consent dialog; the host grants the whole
    // missing set, so a tip consent re-mints carrying this scope too —
    // flips the epoch WITH the scope. The pre-fix code fired the held Like
    // at 2001 here, an item no longer on screen (the audit's probe: one
    // write to item 2001). Now: the granted state is live (reads flow for
    // the item on screen)…
    rerender(
      <Host
        items={[item(2001), item(2002)]}
        hasReactScope
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await waitFor(() => expect(reads().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    // …but the stale tap is not.
    expect(writes()).toHaveLength(0);
  });

  it('a held tap EXPIRES: decline, time passes, a later grant sends nothing', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const t0 = Date.now();
    let now = t0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { rerender } = render(
        <Host
          items={[item(2001)]}
          hasReactScope={false}
          reactTokenEpoch="epoch-1"
          onRequestReactConsent={onRequestReactConsent}
        />,
      );
      await screen.findByTestId('viewer-reactions');
      fireReact('like', true);
      await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));
      expect(writes()).toHaveLength(0);

      // Decline (no token) and the viewer simply leaves it. The held tap's
      // TTL is a minute; ten minutes is past any reading of "short" — the
      // age is read off the wall clock at fire time, which is what the spy
      // moves. This test pins the AGE CHECK, the guarantee for a token
      // that arrives after the TTL (the stash's own timer is the expected
      // path, but a throttled timer cannot be what stands between a late
      // grant and a stale tap): remove the age check and the grant below
      // sends the write and this test goes red. The timer's own pin is
      // the pause-bound test below — it is the death that arrives in
      // silence, with no token at all.
      now = t0 + 10 * 60_000;
      rerender(
        <Host items={[item(2001)]} hasReactScope reactTokenEpoch="epoch-2" onRequestReactConsent={onRequestReactConsent} />,
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(writes()).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('two ungranted taps hold reacted:true — the grant sends ONE write, never an un-react', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const { rerender } = render(
      <Host
        items={[item(2001)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await screen.findByTestId('viewer-reactions');

    // The element flips ITSELF on click, so the second tap's event carries
    // reacted:false (the audit's probe: ungranted clicks held [true,
    // false], and the post-grant write REMOVED a reaction). Ungranted
    // there is no read state to un-react FROM — the held intent is always
    // reacted:true, so both taps hold the same single intent. Each tap
    // asks; neither sends.
    fireReact('like', true);
    fireReact('like', false);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(2));
    expect(writes()).toHaveLength(0);
    expect(reads()).toHaveLength(0);

    rerender(
      <Host items={[item(2001)]} hasReactScope reactTokenEpoch="epoch-2" onRequestReactConsent={onRequestReactConsent} />,
    );
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].payload).toMatchObject({ entityId: 2001, reaction: 'Like', reacted: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
  });

  it('an ungranted tap on a TICKETLESS item asks nothing and holds nothing', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({ reactionStates: { 2001: { counts: { Like: 7 } } } });
    const { rerender } = render(
      <Host
        items={[item(2001, false)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    // The buttons render — the surface is per-viewer, not per-ticket…
    await screen.findByTestId('viewer-reactions');
    fireReact('like', true);
    await new Promise((r) => setTimeout(r, 50));
    // …but the tap is a no-op: even granted, a ticketless write is refused
    // locally by the hook, so there is nothing to ask FOR and nothing to
    // hold.
    expect(onRequestReactConsent).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
    // And a later grant fires nothing on its behalf.
    rerender(
      <Host items={[item(2001, false)]} hasReactScope reactTokenEpoch="epoch-2" onRequestReactConsent={onRequestReactConsent} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
  });

  it('A→B→A: navigating away kills the held tap — coming back does not resurrect it', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({
      reactionStates: { 2001: { counts: { Like: 7 } }, 2002: { counts: { Like: 1 } } },
    });
    const { rerender } = render(
      <Host
        items={[item(2001), item(2002)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));

    // Away to B, then BACK to A. The semantics are decided, not emergent
    // (round-2 audit): the tap died at the first navigation — it was
    // abandoned — and the item being on screen again at grant time does
    // not revive it. This test is what makes the navigation drop the SOLE
    // item guard honestly: a fire-time-only item check would FIRE here
    // (A is current again), and with the drop effect removed this test
    // goes red.
    fireEvent.click(screen.getByTestId('ctrl-next'));
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2'));
    fireEvent.click(screen.getByTestId('ctrl-prev'));
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2'));

    rerender(
      <Host
        items={[item(2001), item(2002)]}
        hasReactScope
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await waitFor(() => expect(reads().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
  });

  it('while a tap is held after a decline, the KEYS still work: ArrowRight navigates — and drops the tap', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({
      reactionStates: { 2001: { counts: { Like: 7 } }, 2002: { counts: { Like: 1 } } },
    });
    const { rerender } = render(
      <Host
        items={[item(2001), item(2002)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));

    // The viewer declines: no new token (nothing rerenders — the decline
    // test above models why), so the tap sits HELD. At round 2 the hold
    // rode the Players' `pickerOpen`, whose keyboard gate swallows EVERY
    // shortcut — arrows, Space/k, f, Escape — for the hold's whole life
    // (up to the 60s TTL), on a screen with no dialog on it (round-3
    // audit). The hold now has its own pause input, which pauses and
    // auto-resumes but gates no keys: ArrowRight must navigate.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2'));

    // …and navigating dropped the held tap (the round-1 rule), so when a
    // later grant lands there is nothing left to fire.
    rerender(
      <Host
        items={[item(2001), item(2002)]}
        hasReactScope
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await waitFor(() => expect(reads().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
  });

  it('fast pacing: auto-advance is PAUSED while a tap is held — tap, time passes, grant → exactly one write', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({
      reactionStates: {
        2001: { counts: { Like: 7 } },
        2002: { counts: { Like: 1 } },
        2003: { counts: { Like: 3 } },
      },
    });
    const items = [item(2001), item(2002), item(2003)];
    const fast: PlayerSettings = { secondsPerImage: 1, videoLoopCount: 1 };
    const { rerender } = render(
      <Host
        items={items}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
        settings={fast}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');

    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));

    // 🔴 THE ROUND-2 PROBE, AS A TEST. At 1s pacing the slideshow advances
    // every second, and a consent dialog outlasts that easily. Pre-fix the
    // item moved at 1s, the (correct) navigation drop killed the held tap,
    // and the grant below sent ZERO writes, silently — the audit measured
    // exactly that at 3bbd4e3f against 1 write pre-round-1. The whole
    // suite missed it because every other test here pins
    // `secondsPerImage: 600`, where auto-advance can never fire. Three
    // items, so a wrap cannot disguise an advance as stillness.
    await new Promise((r) => setTimeout(r, 1600));
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
    expect(writes()).toHaveLength(0);

    // The grant lands with the SAME item still on screen: the held tap
    // fires, exactly once, on the item it was made on.
    rerender(
      <Host
        items={items}
        hasReactScope
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
        settings={fast}
      />,
    );
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].payload).toMatchObject({
      entityId: 2001,
      reaction: 'Like',
      reacted: true,
      ticket: 'ticket-2001',
    });

    // And the pause RELEASED when the tap resolved: playback resumes on
    // its own (it was playing when the hold began) and the slideshow
    // moves on — the hold belonged to the dialog, it is not a new
    // resting state.
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 3'), {
      timeout: 3500,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
  });

  it('the pause is BOUNDED in silence: the stash timer drops a declined tap at the TTL — no token, no navigation', async () => {
    // Fake timers that still advance with real time — the suite's only
    // way to reach a 60s TTL inside a test, while keeping findBy/waitFor
    // and the ordinary short awaits alive.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onRequestReactConsent = vi.fn();
      installHost({
        reactionStates: {
          2001: { counts: { Like: 7 } },
          2002: { counts: { Like: 1 } },
          2003: { counts: { Like: 3 } },
        },
      });
      const items = [item(2001), item(2002), item(2003)];
      const fast: PlayerSettings = { secondsPerImage: 1, videoLoopCount: 1 };
      render(
        <Host
          items={items}
          hasReactScope={false}
          reactTokenEpoch="epoch-1"
          onRequestReactConsent={onRequestReactConsent}
          settings={fast}
        />,
      );
      await screen.findByTestId('viewer-reactions');
      fireReact('like', true);
      await vi.waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));

      // Held and paused: time passes, the item does not move. (The
      // fast-pacing test above proves the pause at real pacing; here the
      // fake clock is the instrument.)
      await vi.advanceTimersByTimeAsync(1500);
      expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');

      // 🔴 THE TIMER'S OWN PIN (round 2). The viewer declines: NO token
      // arrives, no navigation happens, nothing settles the stash — and
      // the TTL passes in that silence. The stash timer is the only
      // mechanism that can fire: it drops the tap, the pause releases,
      // playback resumes and the slideshow moves on by itself. Delete the
      // timer and the walk below never leaves '1 / 3' — the pause the
      // round-2 RED fix added would be bounded by nothing a declining
      // viewer ever does. (The fire-time age check cannot substitute:
      // it runs only when a token arrives, and none does.)
      await vi.advanceTimersByTimeAsync(58_000);
      expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3'); // still held, just inside the TTL
      let label = '';
      for (let step = 0; step < 40 && label !== '2 / 3'; step++) {
        await vi.advanceTimersByTimeAsync(250);
        label = screen.getByTestId('progress-label').textContent ?? '';
        expect(['1 / 3', '2 / 3']).toContain(label);
      }
      expect(label).toBe('2 / 3');
      expect(writes()).toHaveLength(0);
      expect(onRequestReactConsent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reactions — the held-tap pause on EVERY surface (round-3 pins)', () => {
  // 🔴 WHY THESE TWO TESTS EXIST. Round 2 wired the held-tap pause into
  // three surfaces, but only the CLASSIC Player's wiring was pinned (the
  // fast-pacing test above): deleting the hold from the lightbox Player or
  // from ContinuousView left the whole suite green (round-3 audit, by
  // mutation). Each test below is the fast-pacing shape on its own
  // surface — hold → time passes → no advance THERE → grant → exactly one
  // write — and each was verified to go red when only its own surface's
  // wiring is removed.
  const threeItems = () => [item(2001), item(2002), item(2003)];
  const threeStates = () => ({
    reactionStates: {
      2001: { counts: { Like: 7 } },
      2002: { counts: { Like: 1 } },
      2003: { counts: { Like: 3 } },
    },
  });
  const fast: PlayerSettings = { secondsPerImage: 1, videoLoopCount: 1 };

  it('LIGHTBOX: the pause holds the lightbox player — tap in the lightbox, time passes, grant → one write', async () => {
    const onRequestReactConsent = vi.fn();
    installHost(threeStates());
    const items = threeItems();
    const { rerender } = render(
      <Host
        items={items}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
        settings={fast}
        initialMode="continuous-horizontal"
      />,
    );
    // Open the lightbox on the first tile; the action row (and its
    // reaction group) renders INSIDE the dialog while it is up.
    await waitFor(() => expect(screen.getAllByTestId('continuous-tile')).toHaveLength(3));
    fireEvent.click(screen.getAllByTestId('continuous-tile')[0]);
    const lightbox = await screen.findByTestId('lightbox');
    await screen.findByTestId('viewer-reactions');
    expect(lightbox.contains(screen.getByTestId('viewer-reactions'))).toBe(true);
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');

    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));

    // At 1s pacing the lightbox's own player would advance every second.
    // The hold must reach THIS Player instance: with its `consentHold`
    // removed, the label moves to `2 / 3` inside this window and the
    // navigation drop eats the tap before the grant.
    await new Promise((r) => setTimeout(r, 1600));
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 3');
    expect(writes()).toHaveLength(0);

    rerender(
      <Host
        items={items}
        hasReactScope
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
        settings={fast}
        initialMode="continuous-horizontal"
      />,
    );
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].payload).toMatchObject({
      entityId: 2001,
      reaction: 'Like',
      reacted: true,
      ticket: 'ticket-2001',
    });
    // Released with the tap: the lightbox player resumes and moves on.
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 3'), {
      timeout: 3500,
    });
  });

  it('CONTINUOUS: the pause holds the drift — the track stops moving while a tap is held, grant → one write', async () => {
    const onRequestReactConsent = vi.fn();
    installHost(threeStates());
    const items = threeItems();
    const { rerender } = render(
      <Host
        items={items}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
        settings={fast}
        initialMode="continuous-horizontal"
        reducedMotion={false}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    await screen.findByTestId('continuous-track');

    // The drift's fuel is the track's measured length, which jsdom
    // reports as 0 — with a 0 the scroll engine quite correctly never
    // moves, paused or not, and this test would pass with the wiring
    // deleted. Stub the length so the surface is genuinely live: 2400px
    // of track (1200 per copy) at the default 40px/s.
    const track = screen.getByTestId('continuous-track');
    Object.defineProperty(track, 'scrollWidth', { configurable: true, value: 2400 });
    // Prove the surface IS drifting before the tap — a "stillness" claim
    // about a surface that never moved would be vacuous.
    await waitFor(() => expect(track.style.transform).not.toBe('translateX(0px)'), { timeout: 3000 });
    expect(screen.getByTestId('continuous-view').getAttribute('data-autoscroll')).toBe('on');

    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));
    const frozen = track.style.transform;
    expect(frozen).not.toBe('translateX(0px)');
    expect(screen.getByTestId('continuous-view').getAttribute('data-autoscroll')).toBe('off');

    // Held: the drift stops dead, mid-scroll. Remove `tapHeld` from the
    // viewer's `paused` composition and the transform keeps walking
    // through this whole window.
    await new Promise((r) => setTimeout(r, 1200));
    expect(track.style.transform).toBe(frozen);
    expect(writes()).toHaveLength(0);

    // The grant fires the held tap exactly once, on the item it was made
    // on (the wall's current item never changed — the drift that would
    // have moved it was the thing being held).
    rerender(
      <Host
        items={items}
        hasReactScope
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
        settings={fast}
        initialMode="continuous-horizontal"
        reducedMotion={false}
      />,
    );
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].payload).toMatchObject({
      entityId: 2001,
      reaction: 'Like',
      reacted: true,
      ticket: 'ticket-2001',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
  });
});

describe('reactions — a transport press during a held tap cancels the pending auto-resume (round 4)', () => {
  // 🔴 THE ROUND-4 PROBE, AS TESTS. The consent hold inherited the
  // picker's resume: entry capture says "was playing", release calls
  // play(). That premise holds while a modal is up — but a DECLINED tap
  // leaves the hold sitting on a live screen for the rest of the TTL,
  // and a viewer who takes the transport back (play, then a deliberate
  // pause) has overridden the capture. At head the expiry release read
  // only the capture and restarted playback over that pause — for BOTH
  // the Space path and the play-button path the probe exercised. Each
  // path is pinned separately below: they are different wirings into
  // the transport, and unwrapping either one must fail only its own
  // test. The untouched cases stay pinned elsewhere: grant release
  // resumes (fast pacing), silent expiry resumes (the pause-bound test).
  //
  // 🔴 THE CLOCK SHAPE IS THE PAUSE-BOUND TEST'S, DELIBERATELY. A
  // single-shot advance past 60s does NOT reliably cross the TTL in
  // this harness (the stash arms only once the consent round-trip
  // lands, which the fake clock reaches partway through an advance —
  // measured: 62s in one shot left the tap held, a further stepped
  // walk released it). So both tests advance to just inside the TTL,
  // then walk in 250ms steps, asserting the frozen state at EVERY step:
  // a release that wrongly resumed would flip the control and, at 1s
  // pacing, walk the label off `1 / 3` inside the walk. The two play →
  // pause presses are synchronous, so no auto-advance can slip between
  // them and drop the tap by navigation instead.
  const threeItems = () => [item(2001), item(2002), item(2003)];
  const threeStates = () => ({
    reactionStates: {
      2001: { counts: { Like: 7 } },
      2002: { counts: { Like: 1 } },
      2003: { counts: { Like: 3 } },
    },
  });
  const fast: PlayerSettings = { secondsPerImage: 1, videoLoopCount: 1 };
  const playBtn = () => screen.getByTestId('ctrl-play');
  const label = () => screen.getByTestId('progress-label').textContent;

  /** Tap → held → decline-by-silence → the caller's two presses → walk
   *  past the TTL asserting the deliberate pause survives the release. */
  async function declinePlayPauseExpire(press: () => void): Promise<void> {
    const onRequestReactConsent = vi.fn();
    installHost(threeStates());
    render(
      <Host
        items={threeItems()}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
        settings={fast}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    expect(label()).toBe('1 / 3');
    expect(playBtn()).toHaveAttribute('aria-pressed', 'true'); // playing

    fireReact('like', true);
    await vi.waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));
    // The hold lands: playback paused, entry capture = "was playing".
    await vi.waitFor(() => expect(playBtn()).toHaveAttribute('aria-pressed', 'false'));

    // Held at 1s pacing: time passes, the item does not move.
    await vi.advanceTimersByTimeAsync(1500);
    expect(label()).toBe('1 / 3');

    // The viewer declines (no token — nothing rerenders, the tap sits
    // held) and takes the transport back: play, then pause ON PURPOSE.
    press();
    expect(playBtn()).toHaveAttribute('aria-pressed', 'true');
    press();
    expect(playBtn()).toHaveAttribute('aria-pressed', 'false');

    // Up to just inside the TTL: still held, still the viewer's pause.
    await vi.advanceTimersByTimeAsync(58_000);
    expect(playBtn()).toHaveAttribute('aria-pressed', 'false');
    expect(label()).toBe('1 / 3');

    // Walk past the TTL. The stash drops somewhere in here and the hold
    // releases: pre-fix the release replayed the entry capture, the
    // control flipped to playing and the label walked off `1 / 3`.
    for (let step = 0; step < 60; step++) {
      await vi.advanceTimersByTimeAsync(250);
      expect(playBtn()).toHaveAttribute('aria-pressed', 'false');
      expect(label()).toBe('1 / 3');
    }
    expect(writes()).toHaveLength(0);
    expect(onRequestReactConsent).toHaveBeenCalledTimes(1);
  }

  it('SPACE: decline → play → deliberate pause → the TTL release leaves playback paused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await declinePlayPauseExpire(() => fireEvent.keyDown(window, { key: ' ' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('PLAY BUTTON: decline → play → deliberate pause → the TTL release leaves playback paused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await declinePlayPauseExpire(() => fireEvent.click(playBtn()));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reactions — navigation does NOT cancel the auto-resume (round 5)', () => {
  // 🔴 THE OPERATOR DECISION, PINNED. Round 4 marked the hold stale on
  // EVERY transport press, so after a decline, pressing next dropped the
  // tap (navigation drop) but left playback paused — while a scrub,
  // which never marked, let the release resume. The two navigation
  // paths disagreed, and only one of them read the viewer's mind right:
  // navigating says where the stage goes, not whether it plays; only a
  // play/pause press chooses a play state. So only `pressToggle` marks
  // now. Here: tap while playing → decline → press next → the tap is
  // dropped (round 1's rule, unchanged) AND playback RESUMES on the new
  // item. Restoring the mark in pressNext turns this red; the round-4
  // play-then-pause tests above pin the toggle half stays marked.
  it('decline → press next → the tap is dropped and playback resumes on the new item', async () => {
    const onRequestReactConsent = vi.fn();
    installHost({
      reactionStates: { 2001: { counts: { Like: 7 } }, 2002: { counts: { Like: 1 } } },
    });
    const { rerender } = render(
      <Host
        items={[item(2001), item(2002)]}
        hasReactScope={false}
        reactTokenEpoch="epoch-1"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await screen.findByTestId('viewer-reactions');
    expect(screen.getByTestId('progress-label')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'true'); // playing

    fireReact('like', true);
    await waitFor(() => expect(onRequestReactConsent).toHaveBeenCalledTimes(1));
    // The hold lands: playback paused, entry capture = "was playing".
    await waitFor(() =>
      expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'false'),
    );

    // The viewer declines (no new token) and presses NEXT. Navigation
    // drops the held tap — and, the tap gone, the hold releases and the
    // release replays the capture: playback resumes on item 2002.
    fireEvent.click(screen.getByTestId('ctrl-next'));
    await waitFor(() => expect(screen.getByTestId('progress-label')).toHaveTextContent('2 / 2'));
    await waitFor(() =>
      expect(screen.getByTestId('ctrl-play')).toHaveAttribute('aria-pressed', 'true'),
    );

    // The dropped tap stays dropped: a later grant sends nothing.
    rerender(
      <Host
        items={[item(2001), item(2002)]}
        hasReactScope
        reactTokenEpoch="epoch-2"
        onRequestReactConsent={onRequestReactConsent}
      />,
    );
    await waitFor(() => expect(reads().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
  });
});

describe('reactions — the stepped read window', () => {
  const manyItems = (n: number, base: number): MediaItem[] =>
    Array.from({ length: n }, (_, i) => item(base + i));
  const statesFor = (items: MediaItem[]) =>
    Object.fromEntries(items.map((it) => [it.mediaId, { counts: { Like: 1 } }]));

  async function stepTo(position: number, total: number): Promise<void> {
    fireEvent.click(screen.getByTestId('ctrl-next'));
    await waitFor(() =>
      expect(screen.getByTestId('progress-label')).toHaveTextContent(`${position} / ${total}`),
    );
  }

  it('60 items, 9 steps: ONE read of the whole window — stepping inside a block is free', async () => {
    const items = manyItems(60, 4001);
    installHost({ reactionStates: statesFor(items) });
    render(<Host items={items} />);
    await screen.findByTestId('viewer-reactions');
    await waitFor(() => expect(reads()).toHaveLength(1));
    expect((reads()[0].payload as { ids: number[] }).ids).toHaveLength(60);

    // The audit's measured shape: the sliding ±50 window answered these
    // same 9 steps with 9 further 1-id reads ([51,1,1,1,1,1,1,1,1,1]
    // overall). The stepped window's id set does not move inside the
    // block, so there is nothing further to read.
    for (let step = 0; step < 9; step++) await stepTo(step + 2, 60);
    expect(reads()).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it('crossing a block boundary reads only the ids that entered — never one per step', async () => {
    const items = manyItems(120, 5001);
    installHost({ reactionStates: statesFor(items) });
    render(<Host items={items} />);
    await screen.findByTestId('viewer-reactions');
    await waitFor(() => expect(reads()).toHaveLength(1));
    // One window = one 100-id chunk (the hook's real chunk size).
    expect((reads()[0].payload as { ids: number[] }).ids).toEqual(
      Array.from({ length: 100 }, (_, i) => 5001 + i),
    );

    // 49 steps land on index 49 — still block [0…]: the id set has not
    // moved, so no read has been added by ANY of them.
    for (let step = 0; step < 49; step++) await stepTo(step + 2, 120);
    expect(reads()).toHaveLength(1);

    // Step 50 crosses into block [50…]: the window becomes ids 5051…5120,
    // of which 5101…5120 are new — exactly one further read, for exactly
    // those 20 ids (the hook's incrementality), not 50 one-id reads.
    await stepTo(51, 120);
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect((reads()[1].payload as { ids: number[] }).ids).toEqual(
      Array.from({ length: 20 }, (_, i) => 5101 + i),
    );
  });
});
