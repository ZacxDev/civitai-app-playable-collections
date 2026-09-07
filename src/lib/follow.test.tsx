// Unit cover for `useFollowToggle` — the app's ONE follow action.
//
// 🔴 WHY THIS EXISTS SEPARATELY FROM THE e2e SUITE. e2e drives the real mock
// host and proves the wiring; what it cannot do cheaply is pin the ORDER of the
// rejection branches, and the order is the whole correctness argument:
// `declined` and `signInRequired` must be read BEFORE `timedOut`, and all three
// BEFORE `.message` — because a timeout ALSO has `code === undefined`, so
// "no code ⇒ a renderable server message" is false and would put an
// SDK-internal transport string in front of a viewer.
//
// The bridge itself is mocked here on purpose: the subject is this module's
// branch selection, not the transport.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { CollectionFollowError } from '@civitai/blocks-react';

import { useFollowToggle } from './follow.js';

const setFollow = vi.fn();

vi.mock('@civitai/blocks-react', async (orig) => {
  // Keep the REAL CollectionFollowError — constructing genuine instances is what
  // makes `err instanceof CollectionFollowError` meaningful. A hand-rolled stub
  // would let the module's type guard pass on a shape production never sends.
  const actual = await orig<typeof import('@civitai/blocks-react')>();
  return { ...actual, useCollectionFollow: () => ({ setFollow, pending: false, error: null }) };
});

function harness(followed = false) {
  const onChange = vi.fn();
  const onSignInRequired = vi.fn();
  const onNotice = vi.fn();
  const { result } = renderHook(() =>
    useFollowToggle({ collectionId: 42, followed, onChange, onSignInRequired, onNotice }),
  );
  return { result, onChange, onSignInRequired, onNotice };
}

beforeEach(() => {
  setFollow.mockReset();
});

describe('useFollowToggle', () => {
  it('sends the FLIPPED value and adopts the HOST ECHO, not the guess', async () => {
    // The echo can legitimately disagree with what we asked for (unfollowing
    // something already unfollowed echoes false for a request that changed
    // nothing), so the echo is the only value describing what the server holds.
    setFollow.mockResolvedValue({ collectionId: 42, followed: false });
    const { result, onChange } = harness(false);

    await act(async () => result.current.toggle());

    expect(setFollow).toHaveBeenCalledWith({ collectionId: 42, follow: true });
    // Asked for true, host said false → we must report FALSE.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
  });

  it('🔴 a DECLINED follow reports NOTHING — no onChange, no notice', async () => {
    // The viewer dismissed the host's consent dialog and no write occurred.
    // Telling them the app failed is how a consent prompt starts looking broken.
    setFollow.mockRejectedValue(new CollectionFollowError('declined'));
    const { result, onChange, onNotice, onSignInRequired } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(onNotice).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(onSignInRequired).not.toHaveBeenCalled();
  });

  it('sign-in-required routes to sign-in and shows NO error', async () => {
    setFollow.mockRejectedValue(new CollectionFollowError('sign-in-required'));
    const { result, onSignInRequired, onNotice } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() => expect(onSignInRequired).toHaveBeenCalledTimes(1));
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('🔴 a TIMEOUT does not render its .message, and does not claim nothing happened', async () => {
    // The killing case for the branch ORDER. A timeout has code === undefined,
    // so a module that checked `.code` before `.timedOut` would fall through to
    // the free-text branch and print the SDK's own transport string.
    const timeout = new CollectionFollowError(
      'IframeTransport: request "SET_COLLECTION_FOLLOW" timed out after 600000ms',
      { timedOut: true },
    );
    setFollow.mockRejectedValue(timeout);
    const { result, onNotice, onChange } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));
    const [kind, message] = onNotice.mock.calls[0];
    expect(kind).toBe('info');
    expect(message).not.toContain('IframeTransport');
    expect(message).not.toContain('600000');
    // 🔴 And it must NOT be phrased as "nothing happened": the host may have
    // completed the follow and failed only to deliver the reply.
    expect(message).toMatch(/may have gone through/i);
    // No echo to adopt, so the flag must not move either way.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a real SERVER message IS rendered as an error', async () => {
    // The one branch whose .message is meant to be shown. Distinct from the
    // timeout above ONLY by `.timedOut`, which is why they are tested as a pair.
    setFollow.mockRejectedValue(
      new CollectionFollowError('You do not have permission to follow that collection.'),
    );
    const { result, onNotice } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith('error', 'You do not have permission to follow that collection.'),
    );
  });

  it('refuses a second toggle while one is in flight (no double write)', async () => {
    let release: (v: unknown) => void = () => {};
    setFollow.mockReturnValue(new Promise((r) => { release = r; }));
    const { result } = harness(false);

    await act(async () => result.current.toggle());
    // Second press while the host dialog is still open.
    await act(async () => result.current.toggle());
    expect(setFollow).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ collectionId: 42, followed: true });
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});
