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
// 🔴 AND A FOURTH, WHICH THIS COMMENT ASSERTED THE OPPOSITE OF UNTIL AN AUDIT
// CAUGHT IT. It used to say "everything else IS a server message the host
// forwarded verbatim, and is the one branch whose `.message` is meant to be
// shown". That is FALSE for the four remaining CODES. `CollectionFollowError`
// is constructed `super(error)`, so for `invalid-request`, `review-mode`,
// `not-ready` and `collection-unavailable` the `.message` IS the bare code
// string — rendering it shows a viewer the literal words
// "collection-unavailable". Upstream's own class doc pins the renderable branch
// as `code === undefined && !timedOut`; only THAT is a server message.
// So: codes map to sentences (REFUSAL_MESSAGES), and only a code-less,
// non-timeout error has its `.message` shown.
//
// 🔴 NO OPTIMISTIC FLIP HERE. The caller's `followed` prop stays the source of
// truth and we adopt the HOST'S ECHO (`res.followed`), never the guess we sent.
// The two can disagree — an unfollow of something already unfollowed echoes
// `false` for a request that changed nothing — and the echo is the only value
// that describes what the server actually holds.

import { useCallback, useState } from 'react';

import {
  CollectionFollowError,
  useCollectionFollow,
  type BlockCollectionFollowErrorCode,
} from '@civitai/blocks-react';

/**
 * One human sentence per HOST refusal code.
 *
 * 🔴 Keyed on the code, NOT on `.message` — the two are the same string for
 * every code here, which is exactly the trap: rendering `.message` shows a
 * viewer the word `not-ready`. The set is closed and comes from the SDK
 * (`COLLECTION_FOLLOW_ERROR_CODES`); `declined` and `sign-in-required` are
 * handled before this map is reached and deliberately have no entry, because
 * neither is a failure to render.
 */
const REFUSAL_MESSAGES: Partial<Record<BlockCollectionFollowErrorCode, string>> = {
  // The host bounds a block instance to 20 DISTINCT collection ids and refuses
  // past that with the SAME code a collection the viewer cannot see gets — so
  // this sentence must cover both without implying which, or it becomes the
  // enumeration oracle the shared code exists to withhold.
  'collection-unavailable': "That collection can't be followed right now.",
  'invalid-request': "Something went wrong with that request — please try again.",
  'review-mode': 'Following is unavailable while this app is in review.',
  'not-ready': 'Still loading — try that again in a moment.',
};
const FALLBACK_REFUSAL = "That collection can't be followed right now.";

export interface UseFollowToggleArgs {
  /** The collection being followed. */
  collectionId: number;
  /** What the app currently believes, and what a rejection reverts to. */
  followed: boolean;
  /**
   * Adopt the host's echo. Called ONLY after a write the host confirmed.
   *
   * 🔴 IT CARRIES THE COLLECTION ID FROM THE ECHO, and the caller must use THAT
   * rather than whatever it currently considers "open". The reply arrives after
   * a network round trip PLUS however long the viewer spent in the host's
   * consent dialog, and the viewer can navigate in that window: a caller
   * resolving the id from its own current state attributes the write to a
   * collection the viewer never followed.
   */
  onChange: (collectionId: number, followed: boolean) => void;
  /** Route a missing session here instead of showing an error. */
  onSignInRequired: () => void;
  /** Surface a real, renderable message to the viewer. */
  onNotice: (kind: 'success' | 'error' | 'info', message: string) => void;
  /**
   * The write's outcome is UNKNOWN (a transport timeout) — it may well have
   * landed. Drop any cached read of this collection, so the viewer we are about
   * to tell to "check again" is not served the pre-follow flag.
   */
  onUncertain?: () => void;
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
  onUncertain,
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
        // Adopt the ECHO, not `next` — and report the id the ECHO names, not the
        // one this closure captured, so a caller cannot mis-attribute the write.
        onChange(res.collectionId ?? collectionId, res.followed);
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
            // 🔴 THE CACHE MUST BE DROPPED HERE TOO, and this notice is why. A
            // timeout does NOT mean no write occurred, so we tell the viewer to
            // look again — and the app's own 5-minute read cache would have
            // served them the PRE-follow flag, making the app's own advice
            // produce the wrong answer.
            onUncertain?.();
            onNotice('info', 'Still working — this may have gone through. Check the collection in a moment.');
            return;
          }
          // 🔴 A HOST REFUSAL CODE IS NOT A SENTENCE. For the four codes that are
          // not `declined`/`sign-in-required`, `CollectionFollowError` is built
          // as `super(error)`, so `.message` IS the bare code string — rendering
          // it toasts the viewer the literal words "collection-unavailable".
          // Only `code === undefined && !timedOut` carries a server message meant
          // to be shown; upstream's own class doc says exactly that.
          //
          // `collection-unavailable` is not a rare edge here: the host bounds a
          // block instance to 20 DISTINCT collection ids and answers every id
          // past that with this same code, and this app is a full-page
          // collection BROWSER driving many ids in one long-lived instance.
          if (err.code !== undefined) {
            onNotice('error', REFUSAL_MESSAGES[err.code] ?? FALLBACK_REFUSAL);
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
  }, [pending, followed, collectionId, setFollow, onChange, onSignInRequired, onNotice, onUncertain]);

  return { toggle, pending };
}
