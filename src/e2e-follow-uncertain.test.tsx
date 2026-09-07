// 🔴 THE `onFollowUncertain` WIRE, DRIVEN THROUGH THE REAL APP.
//
// The chain is App → CollectionViewer → Player → useFollowToggle →
// `onUncertain` → `cachedApi.invalidateReads()`, and until 0.2.10's audit round
// it was OPTIONAL at every hop: mutating the prop pass in App and BOTH forwards
// in CollectionViewer left the entire suite green (all three SURVIVED). The
// props are required now, so a deletion is a compile error — this file is the
// behavioural half, because a required prop still says nothing about whether
// anything happens when it fires.
//
// The mock host has no "never reply" knob (`collectionFollowError` always
// answers), so the timeout is injected at the SDK hook. Everything else — App,
// the viewer, the player rail, the cached client — is real.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import type { ApiClient } from './lib/api.js';
import { createFakeApi } from './fake-api.js';

const setFollow = vi.fn();

vi.mock('@civitai/blocks-react', async (orig) => {
  // The REAL `CollectionFollowError` — a hand-rolled stub would let the module's
  // `instanceof` guard pass on a shape production never sends.
  const actual = await orig<typeof import('@civitai/blocks-react')>();
  return { ...actual, useCollectionFollow: () => ({ setFollow, pending: false, error: null }) };
});

async function openNeon(api: ApiClient) {
  render(
    <Harness viewer={{ id: 99, username: 'me' }} theme="dark" showLog={false}>
      <App api={api} />
    </Harness>,
  );
  const grid = await screen.findByTestId('collection-grid');
  await userEvent.click(within(grid).getAllByTestId('collection-card')[0]);
  await screen.findByTestId('player');
}

describe('a follow whose outcome is UNKNOWN drops the cached reads', () => {
  it('🔴 a TIMED-OUT follow invalidates, and says so rather than claiming nothing happened', async () => {
    const { CollectionFollowError } = await import('@civitai/blocks-react');
    setFollow.mockRejectedValue(
      new CollectionFollowError(
        'IframeTransport: request "SET_COLLECTION_FOLLOW" timed out after 600000ms',
        { timedOut: true },
      ),
    );
    const invalidateReads = vi.fn();
    const api = { ...createFakeApi({ viewerUserId: 99 }), invalidateReads } as unknown as ApiClient;
    await openNeon(api);
    // Control: merely opening a collection must not invalidate — otherwise a
    // count of 1 below would prove nothing about the follow.
    expect(invalidateReads).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('follow-toggle'));

    await waitFor(() => expect(invalidateReads).toHaveBeenCalledTimes(1));
    // The viewer is told to look again — which is only honest advice once the
    // cache can no longer answer it with the pre-follow flag.
    expect(await screen.findByText(/may have gone through/i)).toBeInTheDocument();
    // And the SDK's internal transport string never reaches them.
    expect(screen.queryByText(/IframeTransport/)).toBeNull();
  });

  it('a follow that SUCCEEDS does not take this path (the negative arm)', async () => {
    setFollow.mockResolvedValue({ collectionId: 101, followed: true });
    const invalidateReads = vi.fn();
    const api = { ...createFakeApi({ viewerUserId: 99 }), invalidateReads } as unknown as ApiClient;
    await openNeon(api);

    await userEvent.click(screen.getByTestId('follow-toggle'));

    // A success invalidates too (via `onFollowChange`), so the discriminator is
    // the NOTICE: it must be the plain success line, not the ambiguity notice.
    expect(await screen.findByText('Following this collection.')).toBeInTheDocument();
    expect(screen.queryByText(/may have gone through/i)).toBeNull();
  });
});
