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
  const onUncertain = vi.fn();
  const { result } = renderHook(() =>
    useFollowToggle({ collectionId: 42, followed, onChange, onSignInRequired, onNotice, onUncertain }),
  );
  return { result, onChange, onSignInRequired, onNotice, onUncertain };
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
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(42, false));
  });

  it('🔴 IGNORES a settle whose echoed collection id is not the one we asked about', async () => {
    // 🔴 RE-POINTED, NOT DELETED — and the old expectation was the defect. This
    // fixture (constructed for 42, host answers about 77) used to assert that the
    // echo's id was ADOPTED and reported through `onChange`, i.e. that a reply
    // about some other collection is allowed to move app state. Upstream's own
    // `FollowButton` correlates instead (`if (!stillOurs(result.collectionId))
    // return;`), and the hand-rolled path has no business being weaker: adopting
    // it records a follow the viewer never made, on an account-write control.
    //
    // The real host cannot produce this fixture (it echoes the const it was
    // handed, and the transport validates it), which is exactly why the guard
    // needs a test — nothing else would ever exercise it.
    setFollow.mockResolvedValue({ collectionId: 77, followed: true });
    const { result, onChange, onNotice } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(onChange).not.toHaveBeenCalled();
    // And it is not reported as a success either — nothing about this reply is
    // ours to render.
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('🔴 IGNORES a settle for the collection it has since moved OFF, even though the echo matches', async () => {
    // The other half of upstream's `stillOurs`, and the half the echo comparison
    // alone cannot see: this hook's `collectionId` PROP moves while a write is
    // settling (a rail bound to "the selected collection", a recycled row). The
    // reply is a perfectly valid echo FOR THE OLD ID — adopting it reports a
    // follow against whatever is bound now.
    let release: (v: unknown) => void = () => {};
    setFollow.mockReturnValue(new Promise((r) => { release = r; }));
    const onChange = vi.fn();
    const onNotice = vi.fn();
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        useFollowToggle({
          collectionId: id,
          followed: false,
          onChange,
          onSignInRequired: vi.fn(),
          onNotice,
          onUncertain: vi.fn(),
        }),
      { initialProps: { id: 42 } },
    );

    await act(async () => result.current.toggle());
    expect(setFollow).toHaveBeenCalledWith({ collectionId: 42, follow: true });
    // The binding moves while the host's consent dialog is still open.
    rerender({ id: 77 });
    await act(async () => {
      release({ collectionId: 42, followed: true });
    });

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(onChange).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('adopts the MATCHING echo’s followed value, disagreeing with the request when it must', async () => {
    // The other half of the pair above: correlation gates on the ID, and must not
    // become an excuse to fall back on the value we SENT. Asked to follow, host
    // says false for id 42 → report false, for 42.
    setFollow.mockResolvedValue({ collectionId: 42, followed: false });
    const { result, onChange } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(42, false));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('🔴 renders a SENTENCE for a host refusal code, never the raw code', async () => {
    // `CollectionFollowError` is `super(error)`, so for these codes `.message`
    // IS the code. `collection-unavailable` is the reachable one: the host caps
    // a block instance at 20 DISTINCT collection ids and answers every id past
    // that with it — and this app is a collection browser.
    setFollow.mockRejectedValue(new CollectionFollowError('collection-unavailable'));
    const { result, onNotice } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));
    const [kind, message] = onNotice.mock.calls[0];
    expect(kind).toBe('error');
    expect(message).not.toContain('collection-unavailable');
    expect(message).not.toMatch(/-/); // no kebab-case code leaked in any form
    expect(message).toBe("That collection can't be followed right now.");
  });

  it('maps every other closed refusal code to its own sentence', async () => {
    // Pairwise-distinct expectations, so a mutant returning one constant for
    // all of them cannot survive.
    const cases: Array<[string, string]> = [
      ['review-mode', 'Following is unavailable while this app is in review.'],
      ['not-ready', 'Still loading — try that again in a moment.'],
      ['invalid-request', 'Something went wrong with that request — please try again.'],
    ];
    for (const [code, expected] of cases) {
      setFollow.mockRejectedValue(new CollectionFollowError(code));
      const { result, onNotice } = harness(false);
      await act(async () => result.current.toggle());
      await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));
      expect(onNotice).toHaveBeenCalledWith('error', expected);
    }
  });

  it('🔴 a TIMEOUT drops the cached reads, because the notice tells them to look again', async () => {
    // Without this the app's own advice produces the wrong answer: the 5-minute
    // read cache would serve the PRE-follow flag to a viewer who was just told
    // the write may have landed.
    setFollow.mockRejectedValue(
      new CollectionFollowError('timed out', { timedOut: true }),
    );
    const { result, onUncertain } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() => expect(onUncertain).toHaveBeenCalledTimes(1));
  });

  it('does NOT drop the cache when nothing is uncertain (success, declined)', async () => {
    // The negative arm: `onUncertain` firing on every path would be
    // indistinguishable from firing on the right one.
    setFollow.mockResolvedValue({ collectionId: 42, followed: true });
    const ok = harness(false);
    await act(async () => ok.result.current.toggle());
    await waitFor(() => expect(ok.onChange).toHaveBeenCalled());
    expect(ok.onUncertain).not.toHaveBeenCalled();

    setFollow.mockRejectedValue(new CollectionFollowError('declined'));
    const declined = harness(false);
    await act(async () => declined.result.current.toggle());
    await waitFor(() => expect(declined.result.current.pending).toBe(false));
    expect(declined.onUncertain).not.toHaveBeenCalled();
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

  it('a real SERVER message IS rendered — and flagged as POST-WRITE-AMBIGUOUS', async () => {
    // The one branch whose .message is meant to be shown. Distinct from the
    // timeout above ONLY by `.timedOut`, which is why they are tested as a pair.
    //
    // 🔴 RE-POINTED: this used to assert the message was rendered BARE, i.e. that
    // a code-less error means "nothing was written". The host cannot promise
    // that — it marks consent, awaits the mutation inside a `try`, and replies
    // `{ error }` from the `catch`, so this one reply covers a refusal AND a
    // failure raised after the row committed. The server's own words are still
    // shown verbatim; what changed is that the app no longer adds a certainty the
    // host never gave it.
    setFollow.mockRejectedValue(
      new CollectionFollowError('You do not have permission to follow that collection.'),
    );
    const { result, onNotice, onUncertain } = harness(false);

    await act(async () => result.current.toggle());

    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));
    const [kind, message] = onNotice.mock.calls[0];
    expect(kind).toBe('error');
    expect(message).toContain('You do not have permission to follow that collection.');
    expect(message).toMatch(/may still have gone through/i);
    // 🔴 And the cache is dropped, for the same reason the timeout branch drops
    // it: the app has just told the viewer to check again, and the 5-minute read
    // cache would answer that with the pre-follow flag.
    expect(onUncertain).toHaveBeenCalledTimes(1);
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
