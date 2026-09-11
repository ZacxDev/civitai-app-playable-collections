import { describe, expect, it } from 'vitest';

import {
  COLLECTION_PERIODS,
  DEFAULT_PERIOD,
  PERIOD_LABEL,
  PERIOD_TESTID,
  PERIOD_WIRE,
  endOfResultsLabel,
  isCollectionPeriod,
  isRankedWindow,
  sortHint,
  windowFallbackNotice,
} from './period.js';

// Every expectation in this file is a LITERAL, written from the acceptance
// criteria and from a live reading of the endpoint (the table at the top of
// period.ts) — never read back out of the implementation.

describe('the five periods', () => {
  it('offers exactly the five MetricTimeframe windows, narrowest first', () => {
    expect(COLLECTION_PERIODS).toEqual(['day', 'week', 'month', 'year', 'allTime']);
  });

  it('defaults to month (criterion 1)', () => {
    expect(DEFAULT_PERIOD).toBe('month');
  });

  it('spells the wire values exactly as the server enum, capitalised', () => {
    // 🔴 Case-sensitive. Measured live: `period=month` is a 400 with
    // `Invalid option: expected one of "Day"|"Week"|"Month"|"Year"|"AllTime"`.
    expect(PERIOD_WIRE).toEqual({
      day: 'Day',
      week: 'Week',
      month: 'Month',
      year: 'Year',
      allTime: 'AllTime',
    });
  });

  it('labels and testids cover every period', () => {
    expect(PERIOD_LABEL).toEqual({
      day: 'Today',
      week: 'This week',
      month: 'This month',
      year: 'This year',
      allTime: 'All time',
    });
    expect(PERIOD_TESTID).toEqual({
      day: 'period-day',
      week: 'period-week',
      month: 'period-month',
      year: 'period-year',
      allTime: 'period-alltime',
    });
  });

  it('narrows an unknown value, rejecting the wire spellings', () => {
    expect(isCollectionPeriod('month')).toBe(true);
    expect(isCollectionPeriod('allTime')).toBe(true);
    // The WIRE spelling is not an app value — accepting it here is how a server
    // string leaks into state that indexes the label maps.
    expect(isCollectionPeriod('Month')).toBe(false);
    expect(isCollectionPeriod('')).toBe(false);
    expect(isCollectionPeriod(null)).toBe(false);
    expect(isCollectionPeriod(3)).toBe(false);
  });

  it('treats only day/week/month/year as ranked windows', () => {
    expect(isRankedWindow('day')).toBe(true);
    expect(isRankedWindow('week')).toBe(true);
    expect(isRankedWindow('month')).toBe(true);
    expect(isRankedWindow('year')).toBe(true);
    // AllTime is served from Postgres BY DESIGN — not a degraded ranked window.
    expect(isRankedWindow('allTime')).toBe(false);
  });
});

describe('sortHint', () => {
  it('names the active period on the popular sort (criterion 4)', () => {
    expect(sortHint('popular', 'day')).toBe('Sorted by most followed. Popular today.');
    expect(sortHint('popular', 'week')).toBe('Sorted by most followed. Popular this week.');
    expect(sortHint('popular', 'month')).toBe('Sorted by most followed. Popular this month.');
    expect(sortHint('popular', 'year')).toBe('Sorted by most followed. Popular this year.');
    expect(sortHint('popular', 'allTime')).toBe('Sorted by most followed. Popular all time.');
  });

  it('🔴 keeps the exact literal the app-capture recipe waits on, for EVERY period', () => {
    // `civitai/talos-infra`'s
    // `.claude/skills/app-capture/scripts/recipes/playable-collections.json`
    // drives its `player` state with `{"waitForGone": "Sorted by most followed."}`,
    // a TEXT match on the grid's hint. Reword the sentence and that wait does not
    // go red — it goes VACUOUSLY GREEN, because a literal that is never present
    // is trivially absent, and the recipe silently stops proving the player
    // opened. Pinning the substring here is the whole reason the period is a
    // SECOND sentence rather than folded into the first.
    for (const p of COLLECTION_PERIODS) {
      expect(sortHint('popular', p)).toContain('Sorted by most followed.');
    }
  });

  it('leaves the newest hint exactly as it was, with no period (criterion 6)', () => {
    // The app sends no period on this sort, so naming one would assert a filter
    // that is not being applied.
    for (const p of COLLECTION_PERIODS) {
      expect(sortHint('newest', p)).toBe('Sorted newest first.');
    }
  });
});

describe('endOfResultsLabel', () => {
  it('names the window and the way out on a ranked window', () => {
    expect(endOfResultsLabel('popular', 'month')).toBe(
      "That's the end of this month's popular collections — pick a longer window for more.",
    );
    expect(endOfResultsLabel('popular', 'day')).toBe(
      "That's the end of today's popular collections — pick a longer window for more.",
    );
  });

  it('stays generic where there is no window to widen', () => {
    // All-time already pages the whole corpus, and newest carries no window.
    expect(endOfResultsLabel('popular', 'allTime')).toBe("That's the end of the results.");
    expect(endOfResultsLabel('newest', 'month')).toBe("That's the end of the results.");
  });
});

describe('windowFallbackNotice', () => {
  const NOTICE = "Ranking for this month isn't available right now — showing all-time popularity instead.";

  it('is silent when a ranked window was served from ClickHouse', () => {
    expect(windowFallbackNotice('month', { source: 'clickhouse', period: 'Month' })).toBeNull();
  });

  it('🔴 is silent on a HEALTHY AllTime request, which carries a sourceReason', () => {
    // Measured live: `period=AllTime` returns
    // `source: 'postgres', sourceReason: 'all-time-served-from-postgres'`.
    // Keying the warning on `sourceReason != null` would fire on the single most
    // ordinary request this feature makes.
    expect(
      windowFallbackNotice('allTime', {
        source: 'postgres',
        period: 'AllTime',
        sourceReason: 'all-time-served-from-postgres',
      }),
    ).toBeNull();
  });

  it('warns when a ranked window came back from an unranked store', () => {
    expect(
      windowFallbackNotice('month', {
        source: 'postgres',
        period: 'Month',
        sourceReason: 'clickhouse-unavailable',
      }),
    ).toBe(NOTICE);
  });

  it('warns when the server applied a DIFFERENT window than the one asked for', () => {
    // Same store, but not the window requested — still not what the hint claims.
    expect(windowFallbackNotice('month', { source: 'clickhouse', period: 'AllTime' })).toBe(NOTICE);
  });

  it('warns without a reason string, because the reason is not the signal', () => {
    expect(windowFallbackNotice('week', { source: 'postgres', period: 'Week' })).toBe(
      "Ranking for this week isn't available right now — showing all-time popularity instead.",
    );
  });

  it('🔴 says nothing to a host that predates the param (no provenance at all)', () => {
    // An older deployment ignores `period` and returns no `source` key. The card
    // assumes that degrades to today's behaviour rather than erroring — a
    // permanent scare note under every grid is not that.
    expect(windowFallbackNotice('month', { })).toBeNull();
    expect(windowFallbackNotice('month', undefined)).toBeNull();
    expect(windowFallbackNotice('month', null)).toBeNull();
  });

  it('says nothing when no window was requested', () => {
    expect(windowFallbackNotice(undefined, { source: 'postgres', sourceReason: 'whatever' })).toBeNull();
  });
});
