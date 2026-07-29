// Session-level "I'm 18+" maturity acknowledgement.
//
// Dogfood finding: mature items were gated PER MEDIA ID (tap-to-reveal), so the
// "sit back and play" loop broke — every advance re-blurred the next mature
// item, and it even re-gated in ambient/cast (passive TV) mode. This holds a
// SINGLE session-level acknowledgement instead: the viewer confirms once and the
// whole playthrough is unblurred.
//
// 🔴 Why module memory (not Web Storage): the block runs in an OPAQUE-ORIGIN
// sandboxed iframe where `localStorage` / `sessionStorage` THROW. So we can't
// persist the ack to storage; we hold it in module scope, which lives for the
// lifetime of the loaded block (the browsing "session") and is SHARED across
// every Player instance — confirming once unblurs the classic view AND the
// lightbox AND ambient mode simultaneously, and advancing never re-asks.
//
// 🔴 Fail-closed: starts FALSE. Mature / unrated media stays blurred until the
// viewer explicitly accepts. This does NOT weaken maturity — it only stops
// RE-ASKING once the viewer has confirmed they're 18+.

import { useSyncExternalStore } from 'react';

let accepted = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Has the viewer accepted the session-level "I'm 18+" gate? */
export function isMatureGateAccepted(): boolean {
  return accepted;
}

/** Accept the gate for the rest of the session (unblurs the whole playthrough). */
export function acceptMatureGate(): void {
  if (accepted) return;
  accepted = true;
  emit();
}

/** Test seam: reset the module-level ack between tests (fail-closed default). */
export function resetMatureGate(): void {
  if (!accepted) return;
  accepted = false;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Subscribe a component to the session-level maturity ack. Returns the current
 * `accepted` flag plus an `accept()` action; re-renders every subscriber when
 * the gate is accepted so all Player instances unblur together.
 */
export function useMatureGate(): { accepted: boolean; accept: () => void } {
  const value = useSyncExternalStore(subscribe, isMatureGateAccepted, isMatureGateAccepted);
  return { accepted: value, accept: acceptMatureGate };
}
