// WHO a tip is for, and HOW the app sends one.
//
// 🔴 THIS MODULE EXISTS BECAUSE THESE TYPES OUTLIVED THEIR ORIGINAL HOME. They
// used to be declared inside `components/TipModal.tsx` — the single-target
// amount picker — so every consumer of "what is a tip target" imported a
// component module to get it. `TipModal` was deleted when the three tip
// affordances were consolidated into ONE picker (T5): the app now has exactly
// one tip control per view, and the surviving picker is `TipSplitModal`, which
// spans creator-only / split / curator-only. The types are app-wide, so they
// live in `lib/` and not inside whichever component happens to render today.
//
// 🔴 THE SHAPE IS DELIBERATELY THE UPSTREAM HOOK'S SHAPE. `useTip()` from
// `@civitai/blocks-react` posts `TipParams { toUserId, amount, entityType,
// entityId }` with `TipOptions { idempotencyKey }`, and this app sends the same
// four fields plus the same key through its own injected `ApiClient` (see the
// non-goal recorded in `lib/tip-allowance.ts`: the upstream hook raw-`fetch`es,
// which would bypass the fake every test and the dev harness depend on, and lose
// this client's `ApiError` taxonomy). `tip-hook-parity.test.ts` is what stops
// those two shapes drifting apart silently.

/** One side a tip can be sent to, resolved to the exact entity it is for. */
export interface TipTarget {
  kind: 'creator' | 'curator';
  toUserId: number;
  username: string | null;
  entityType: 'Image' | 'Collection';
  entityId: number;
}

/**
 * Perform one transfer. Resolves `true` only on a confirmed tip.
 *
 * 🔴 `idempotencyKey` IS LOAD-BEARING. A split press fires two transfers, so it
 * can half-fail; the retry re-sends the outstanding leg under the SAME key so
 * the server replays rather than transfers again. It is optional only because
 * the type is also used where no retry affordance exists.
 */
export type TipSender = (target: TipTarget, amount: number, idempotencyKey?: string) => Promise<boolean>;
