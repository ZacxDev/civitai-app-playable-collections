import { describe, expect, it, vi } from 'vitest';

import { createAnalytics, type TrackedEvent } from './analytics.js';

describe('createAnalytics', () => {
  it('emits each event to the sink with a timestamp', () => {
    const events: TrackedEvent[] = [];
    const a = createAnalytics((e) => events.push(e), () => 1000);
    a.track({ type: 'play', collectionId: 101 });
    a.track({ type: 'tip', kind: 'creator', amount: 50 });
    a.track({ type: 'mode_switch', collectionId: 101, mode: 'continuous-vertical' });
    expect(events).toEqual([
      { type: 'play', collectionId: 101, at: 1000 },
      { type: 'tip', kind: 'creator', amount: 50, at: 1000 },
      { type: 'mode_switch', collectionId: 101, mode: 'continuous-vertical', at: 1000 },
    ]);
  });

  it('is inert with no sink', () => {
    const a = createAnalytics();
    expect(() => a.track({ type: 'follow', collectionId: 1, followed: true })).not.toThrow();
  });

  it('never lets a throwing sink break the app', () => {
    const sink = vi.fn(() => {
      throw new Error('sink boom');
    });
    const a = createAnalytics(sink);
    expect(() => a.track({ type: 'popular_open', collectionId: 5 })).not.toThrow();
    expect(sink).toHaveBeenCalled();
  });
});
