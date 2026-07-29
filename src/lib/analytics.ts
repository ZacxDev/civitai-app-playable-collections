// Lightweight analytics (Feature #10).
//
// The block previously emitted zero product telemetry. This defines a small,
// typed event set for the money/engagement moments (play, mode-switch, tip,
// follow, popular-open, plus share/cast) and a pluggable SINK. There is no
// dedicated host analytics bridge yet, so the default sink is a no-op; the app
// wires a sink (a test injects one, and a real transport — e.g. a host
// postMessage event or a beacon — plugs in here in one place).

import { useMemo } from 'react';

import type { ViewMode } from '../view-modes.js';

export type AnalyticsEvent =
  | { type: 'play'; collectionId: number }
  | { type: 'mode_switch'; collectionId: number; mode: ViewMode }
  | { type: 'tip'; kind: 'creator' | 'curator'; amount: number }
  | { type: 'follow'; collectionId: number; followed: boolean }
  | { type: 'popular_open'; collectionId: number }
  | { type: 'share'; collectionId: number }
  | { type: 'cast'; on: boolean };

/** A tracked event carries a wall-clock timestamp. */
export type TrackedEvent = AnalyticsEvent & { at: number };
export type AnalyticsSink = (event: TrackedEvent) => void;

export interface Analytics {
  track(event: AnalyticsEvent): void;
}

/** Build an analytics emitter over a sink. A missing/throwing sink is inert. */
export function createAnalytics(sink?: AnalyticsSink, now: () => number = Date.now): Analytics {
  return {
    track(event) {
      if (!sink) return;
      try {
        sink({ ...event, at: now() });
      } catch {
        // Telemetry must never break the app.
      }
    },
  };
}

/** Hook wrapper — stable per sink identity. */
export function useAnalytics(sink?: AnalyticsSink): Analytics {
  return useMemo(() => createAnalytics(sink), [sink]);
}
