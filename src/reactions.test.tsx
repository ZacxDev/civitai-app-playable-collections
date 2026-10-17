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
//   - the token predicate is the switch: a token carrying
//     `social:react:self` (granted here through the `isReactGranted` seam,
//     because the mock host's BLOCK_INIT token carries no app scopes) gets
//     reaction controls in the player AND exactly one windowed read behind
//     them — with the tickets the fake collection endpoint attached riding
//     through App's own data path (fake API → loader → viewer);
//   - a token without it — the pre-approval build, the not-yet-consented
//     viewer, the anonymous viewer — gets NO controls and issues NO reads.
//     Inert by design, not broken by accident.
//
// The mock host is seeded with reaction state for the fake collection's
// first item (mediaId 1001), so the group rendering at all proves the read
// answered for the item on screen.
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
    expect((reads[0].payload as { tickets: Record<string, string> }).tickets['1001']).toBe('fake-ticket-1001-g1');
  });

  it('not granted: no controls, no reads — the pre-approval state is inert', async () => {
    const outbound: { type: string; payload?: unknown }[] = [];
    const api = createFakeApi({ viewerUserId: 99, reactTickets: true });
    renderApp({ api, onOutbound: (m) => outbound.push(m) });
    await openFirstCollection();

    // The player is fully up (the tip chrome proves the action row rendered)…
    await screen.findByTestId('chrome-tip');
    // …but there is no reaction group, and nothing was read.
    expect(screen.queryByTestId('viewer-reactions')).toBeNull();
    await waitFor(() => expect(outbound.filter((m) => m.type === 'GET_ENTITY_REACTIONS')).toHaveLength(0));
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
