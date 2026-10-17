import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import { createFakeApi, type FakeApi } from './fake-api.js';
import { createRestFake } from './dev-rest.js';
import { configureSdkRuntime } from './lib/sdk-runtime.js';

// ============================================================================
// 🔴 THE TOKEN GATE, END TO END AT THE APP LEVEL. The viewer's bridge-level
// behaviour lives in `components/reactions.test.tsx`; this file proves the
// App-side half of the contract:
//
//   - the token predicate switches the READS: a token carrying
//     `social:react:self` (granted here through the `isReactGranted` seam,
//     because the mock host's BLOCK_INIT token carries no app scopes) gets
//     reaction controls bound to real state AND exactly one windowed read
//     behind them — with the tickets the fake collection endpoint attached
//     riding through App's own data path (fake API → loader → viewer);
//   - a signed-in token WITHOUT it (the not-yet-consented viewer, a viewer
//     who installed an earlier version) gets the buttons WITHOUT counts
//     and issues NO reads — the tips pattern: show the surface, ask on
//     press. Reads stay inert by design, not broken by accident;
//   - an anonymous viewer gets no reaction UI at all.
//
// The mock host is seeded with reaction state for the fake collection's
// first item (mediaId 1001), so the granted group rendering at all proves
// the read answered for the item on screen.
// ============================================================================

interface RenderOpts {
  api: FakeApi;
  isReactGranted?: (tokenScopes: string[]) => boolean;
  viewer?: { id: number; username: string } | null;
  onOutbound?: (msg: { type: string; payload?: unknown }) => void;
}

function renderApp(opts: RenderOpts) {
  configureSdkRuntime({ fetch: createRestFake({ viewerUserId: 99 }) });
  return render(
    <Harness
      viewer={opts.viewer === undefined ? { id: 99, username: 'me' } : opts.viewer}
      theme="dark"
      showLog={false}
      declaredScopes={['social:react:self']}
      reactionStates={{ 1001: { counts: { Like: 4, Heart: 2 }, viewerReactions: ['Heart'] } }}
      onOutbound={opts.onOutbound}
    >
      <App api={opts.api} isTipGranted={() => true} isReactGranted={opts.isReactGranted} />
    </Harness>,
  );
}

async function openFirstCollection(): Promise<void> {
  const grid = await screen.findByTestId('collection-grid');
  await userEvent.click(within(grid).getAllByTestId('collection-card')[0]);
  await screen.findByTestId('player');
}

describe('App — reactions token gate', () => {
  it('granted: the player shows reaction controls and reads once, tickets riding through', async () => {
    const outbound: { type: string; payload?: unknown }[] = [];
    const api = createFakeApi({ viewerUserId: 99, reactTickets: true });
    renderApp({ api, isReactGranted: () => true, onOutbound: (m) => outbound.push(m) });
    await openFirstCollection();

    await screen.findByTestId('viewer-reactions');
    const reads = outbound.filter((m) => m.type === 'GET_ENTITY_REACTIONS');
    expect(reads).toHaveLength(1);
    // The ticket on the wire is the one the fake endpoint attached — proof
    // the plumbing runs endpoint payload → MediaItem → hook, not a fixture
    // shortcut inside the viewer.
    expect((reads[0].payload as { tickets: Record<string, string> }).tickets['1001']).toBe('fake-ticket-1001');
  });

  it('not granted: the buttons render count-less, and no read is issued', async () => {
    const outbound: { type: string; payload?: unknown }[] = [];
    const api = createFakeApi({ viewerUserId: 99, reactTickets: true });
    renderApp({ api, onOutbound: (m) => outbound.push(m) });
    await openFirstCollection();

    // The signed-in viewer SEES the surface (the tips pattern)…
    await screen.findByTestId('viewer-reactions');
    // …bound from no state: the count-hiding class marks every element,
    // because no read stands behind them.
    for (const name of ['like', 'heart', 'laugh', 'cry']) {
      expect(screen.getByTestId(`reaction-${name}`).classList.contains('pc-reaction-unknown')).toBe(true);
    }
    // And nothing was read: reads are the granted-only half of the gate.
    await waitFor(() => expect(outbound.filter((m) => m.type === 'GET_ENTITY_REACTIONS')).toHaveLength(0));
    expect(outbound.filter((m) => m.type === 'SET_ENTITY_REACTION')).toHaveLength(0);
  });

  it('anonymous viewer: no tickets exist, so no controls and no sign-in nag', async () => {
    const outbound: { type: string; payload?: unknown }[] = [];
    const api = createFakeApi({ viewerUserId: 99, reactTickets: true });
    renderApp({ api, viewer: null, onOutbound: (m) => outbound.push(m) });
    await openFirstCollection();

    await screen.findByTestId('chrome-tip');
    expect(screen.queryByTestId('viewer-reactions')).toBeNull();
    expect(outbound.filter((m) => m.type === 'GET_ENTITY_REACTIONS')).toHaveLength(0);
  });
});
