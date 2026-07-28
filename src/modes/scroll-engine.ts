// Pure auto-scroll math for the continuous (marquee / wall) view modes.
//
// The animation loop lives in ContinuousView (rAF); ALL the arithmetic lives
// here so it is unit-testable without a real animation frame:
//   - `advanceOffset(offset, dt, speed, contentSize)` → next wrapped offset.
//   - `shouldAutoScroll(reducedMotion, paused)`       → the branch selection.
//
// Seamless looping: the view renders TWO back-to-back copies of the content and
// translates by `offset`, where `offset` is kept within `[0, contentSize)` and
// `contentSize` is the length of ONE copy. When offset wraps past contentSize it
// lands back near 0 with the second copy already filling the gap — no visible
// jump.

/**
 * Advance a scroll offset by `speed` px/s over `dt` seconds, wrapping into
 * `[0, contentSize)`. Pure.
 *
 *  - `contentSize <= 0` (nothing measured yet) → 0.
 *  - Negative motion (e.g. a reversed marquee) wraps correctly too, since the
 *    result is normalized with a floored modulo.
 *  - Non-finite inputs (a bad dt from a paused rAF gap) are treated as no-ops.
 */
export function advanceOffset(offset: number, dt: number, speed: number, contentSize: number): number {
  if (!(contentSize > 0)) return 0;
  if (!Number.isFinite(offset) || !Number.isFinite(dt) || !Number.isFinite(speed)) {
    return wrap(offset, contentSize);
  }
  const raw = offset + speed * dt;
  return wrap(raw, contentSize);
}

/** Normalize `value` into `[0, size)` with a floored modulo (handles negatives). */
export function wrap(value: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(value)) return 0;
  return ((value % size) + size) % size;
}

/**
 * Whether the ambient auto-scroll should run right now. 🔴 `prefers-reduced-
 * motion` HARD-disables it (the mode falls back to plain user-driven scrolling);
 * an explicit user pause also disables it. Pure so the reduced-motion branch is
 * directly unit-testable.
 */
export function shouldAutoScroll(reducedMotion: boolean, paused: boolean): boolean {
  return !reducedMotion && !paused;
}

/** Clamp a delta-time (seconds) to a sane frame budget so a backgrounded tab
 * that resumes with a huge dt doesn't teleport the scroll. */
export function clampDt(dt: number, maxDt = 0.1): number {
  if (!Number.isFinite(dt) || dt < 0) return 0;
  return Math.min(dt, maxDt);
}
