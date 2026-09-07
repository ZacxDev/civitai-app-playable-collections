// The app's ONE follow action, on top of the host-mediated
// `SET_COLLECTION_FOLLOW` bridge (`useCollectionFollow` from
// @civitai/blocks-react, 0.48.0+).
//
// 🔴 WHY THIS EXISTS RATHER THAN A `catch (err) { toast(errMessage(err)) }`.
// Until 0.2.10 the app followed over HTTP (`api.setFollow`, scope
// `collections:write:self`) and treated EVERY rejection the same way. The bridge
// has three rejections that are NOT failures to render, and the old shape got
// all three wrong the moment it met them:
//
//   - `declined` — the viewer dismissed the HOST's consent confirm, so nothing
//     was written. Telling someone who chose "no" that the platform failed is
//     the single most likely way to make a consent prompt look broken. Say
//     nothing and put the state back.
//   - `sign-in-required` — there is no session. The next step is signing in, not
//     retrying, so this routes into the host's sign-in request.
//   - `timedOut` — no reply ever arrived. 🔴 This does NOT mean no write
//     occurred: the host may have completed the follow and failed only to
//     deliver the reply. Its `.message` is an SDK-internal string
//     (`IframeTransport: request "SET_COLLECTION_FOLLOW" timed out after
//     600000ms`), so rendering it puts transport noise in front of a viewer.
//     Check `.timedOut` BEFORE `.message`.
//
// Everything else IS a server message the host forwarded verbatim, and is the
// one branch whose `.message` is meant to be shown.
//
// 🔴 NO OPTIMISTIC FLIP HERE. The caller's `followed` prop stays the source of
// truth and we adopt the HOST'S ECHO (`res.followed`), never the guess we sent.
// The two can disagree — an unfollow of something already unfollowed echoes
// `false` for a request that changed nothing — and the echo is the only value
// that describes what the server actually holds.

import { useCallback, useState } from 'react';

import { CollectionFollowError, useCollectionFollow } from '@civitai/blocks-react';

export interface UseFollowToggleArgs {
  /** The collection being followed. */
  collectionId: number;
  /** What the app currently believes, and what a rejection reverts to. */
  followed: boolean;
  /** Adopt the host's echo. Called ONLY after a write the host confirmed. */
  onChange: (followed: boolean) => void;
  /** Route a missing session here instead of showing an error. */
  onSignInRequired: () => void;
  /** Surface a real, renderable message to the viewer. */
  onNotice: (kind: 'success' | 'error' | 'info', message: string) => void;
}

export interface FollowToggle {
  /** Ask the host to flip `followed`. Opens the host's consent confirm. */
  toggle: () => void;
  /** True while a request is in flight — INCLUDING the viewer's confirm. */
  pending: boolean;
}

export function useFollowToggle({
  collectionId,
  followed,
  onChange,
  onSignInRequired,
  onNotice,
}: UseFollowToggleArgs): FollowToggle {
  const { setFollow } = useCollectionFollow();
  // Own `pending` rather than the hook's: the hook is instanced per caller, and
  // this keeps the disabled window tied to the press that opened the dialog.
  const [pending, setPending] = useState(false);

  const toggle = useCallback(() => {
    if (pending) return;
    const next = !followed;
    setPending(true);
    void (async () => {
      try {
        const res = await setFollow({ collectionId, follow: next });
        // Adopt the ECHO, not `next`.
        onChange(res.followed);
        onNotice('success', res.followed ? 'Following this collection.' : 'Unfollowed this collection.');
      } catch (err) {
        if (err instanceof CollectionFollowError) {
          // Order matters: `declined` and `signInRequired` are not failures, and
          // `timedOut` must be read BEFORE `.message` (both have no `.code`).
          if (err.declined) return;
          if (err.signInRequired) {
            onSignInRequired();
            return;
          }
          if (err.timedOut) {
            onNotice('info', 'Still working — this may have gone through. Check the collection in a moment.');
            return;
          }
          onNotice('error', err.message);
          return;
        }
        onNotice('error', err instanceof Error ? err.message : 'Could not update this collection.');
      } finally {
        setPending(false);
      }
    })();
  }, [pending, followed, collectionId, setFollow, onChange, onSignInRequired, onNotice]);

  return { toggle, pending };
}
