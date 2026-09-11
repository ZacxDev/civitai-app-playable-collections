// The popularity WINDOW ("popular this day / week / month / year / all time").
//
// The server side shipped first: `GET /api/v1/blocks/collections` now accepts a
// `period` param validated against exactly `Day | Week | Month | Year | AllTime`
// (the `MetricTimeframe` enum). Day/Week/Month/Year are ranked in ClickHouse;
// `AllTime` — and an ABSENT period — take the original Postgres ordering.
//
// 🔴 `period` IS HONOURED ONLY FOR THE POPULARITY SORT. `sort=Newest&period=Week`
// is accepted, ignored, and explained back via `sourceReason`. This app therefore
// never SENDS a period on the newest sort (see `App.tsx`), so that branch is
// contract fidelity in the fake rather than a path the UI can reach.
//
// Measured against live 2026-09-11 with a dev token (`limit=6`, `mode=public`):
//
//   sort=Most Followers period=Day     -> source=clickhouse period=Day     reason=—
//   sort=Most Followers period=Week    -> source=clickhouse period=Week    reason=—
//   sort=Most Followers period=Month   -> source=clickhouse period=Month   reason=—
//   sort=Most Followers period=Year    -> source=clickhouse period=Year    reason=—
//   sort=Most Followers period=AllTime -> source=postgres   period=AllTime reason=all-time-served-from-postgres
//   sort=Most Followers period=<absent>-> no source/period/sourceReason keys at all
//   sort=Newest        period=Week     -> source=postgres   period=Week    reason=period-ignored-for-non-popularity-sort
//   mode=mine          period=Month    -> source=postgres   period=Month   reason=period-ignored-outside-public-discovery
//   mode=mine          period=AllTime  -> source=postgres   period=AllTime reason=all-time-served-from-postgres
//   period=month (lowercase)           -> HTTP 400, Zod fieldErrors.period
//
// 🔴 THAT `mode=mine` ROW IS WHY THE APP SENDS NO PERIOD THERE. The window is
// ignored outside public discovery — the viewer's own collections come back
// complete and in the same order, so nothing is HIDDEN — but the response is
// `source: 'postgres'` for a ranked window, which is indistinguishable at the
// consumer from ClickHouse being down. Sending it would have put a false
// "ranking isn't available right now" note under the Mine tab permanently. The
// tab having no popularity window is also a stated non-goal of the task, so the
// fix and the scope agree: the period is a PUBLIC-DISCOVERY concept.
//
// Two things in that table drive the code below and are easy to get wrong:
//   1. `sourceReason` is present on a perfectly HEALTHY AllTime request. Its mere
//      presence is NOT a degradation signal — see `windowFallbackNotice`.
//   2. An absent `period` yields NO `source` key, which is exactly what a host
//      predating the param looks like. That is why the fallback check requires
//      `source` to be PRESENT before it will warn about anything.

/**
 * The app's friendly period values.
 *
 * Mirrors `CollectionSort`: the app, the UI and the fake api all speak these
 * lowercase names, and ONLY the HTTP wire is translated (`PERIOD_PARAM` in
 * lib/api.ts). Keeping the translation at the network boundary is what let the
 * sort survive the server renaming its enum, and it is why a test can assert on
 * `'month'` without encoding a server spelling.
 */
export type CollectionPeriod = 'day' | 'week' | 'month' | 'year' | 'allTime';

/**
 * The window a first visit lands on (acceptance criterion 1).
 *
 * 🔴 This makes the ClickHouse-ranked path the DEFAULT for every visitor, and it
 * BOUNDS THE BROWSE SURFACE. Of the top 10,000 ClickHouse-ranked collections only
 * ~446 are `Image` type, and the grid shows Image collections only — so a windowed
 * feed ends at roughly 446 collections, ~18 pages at `limit=24`, where AllTime
 * pages the whole corpus. `endOfResultsLabel` below exists because of that: the
 * grid used to render NOTHING at the end of a list, which at 18 pages reads as a
 * broken loader rather than as the end.
 */
export const DEFAULT_PERIOD: CollectionPeriod = 'month';

/** Every period, in the order the control renders them (narrowest first). */
export const COLLECTION_PERIODS: readonly CollectionPeriod[] = [
  'day',
  'week',
  'month',
  'year',
  'allTime',
] as const;

/** Is this one of the five known periods? Narrows an unknown string. */
export function isCollectionPeriod(value: unknown): value is CollectionPeriod {
  return typeof value === 'string' && (COLLECTION_PERIODS as readonly string[]).includes(value);
}

/** Chip label for each period. */
export const PERIOD_LABEL: Record<CollectionPeriod, string> = {
  day: 'Today',
  week: 'This week',
  month: 'This month',
  year: 'This year',
  allTime: 'All time',
};

/** `data-testid` for each period chip. */
export const PERIOD_TESTID: Record<CollectionPeriod, string> = {
  day: 'period-day',
  week: 'period-week',
  month: 'period-month',
  year: 'period-year',
  allTime: 'period-alltime',
};

/**
 * Is this window RANKED (ClickHouse), as opposed to the unwindowed ordering?
 *
 * `allTime` is not — the server serves it from Postgres by design, which is why
 * its `all-time-served-from-postgres` reason must never raise a warning.
 */
export function isRankedWindow(period: CollectionPeriod): boolean {
  return period !== 'allTime';
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** The period half of the sort hint, as a standalone sentence. */
export const PERIOD_SENTENCE: Record<CollectionPeriod, string> = {
  day: 'Popular today.',
  week: 'Popular this week.',
  month: 'Popular this month.',
  year: 'Popular this year.',
  allTime: 'Popular all time.',
};

/**
 * 🔴 THE EXACT STRING AN EXTERNAL CONSUMER WAITS ON — DO NOT REWORD IT.
 *
 * `civitai/talos-infra`'s app-capture recipe
 * (`.claude/skills/app-capture/scripts/recipes/playable-collections.json`) drives
 * the `player` state with `{"waitForGone": "Sorted by most followed."}`. That op
 * matches TEXT, not a testid, so the grid's sort hint disappearing is how the
 * recipe knows the player opened.
 *
 * 🔴 AND ITS FAILURE MODE IS VACUOUS GREEN, NOT RED. If this sentence were
 * reworded to "Sorted by most followed this month." the recipe would not go red —
 * the literal it waits on would simply never be present, so "expect absent" would
 * pass instantly and stop proving the grid went away. That is strictly worse than
 * a red check, and it is why the period is appended as a SECOND SENTENCE instead
 * of being folded into this one. `period.test.ts` pins the literal.
 */
export const POPULAR_SORT_SENTENCE = 'Sorted by most followed.';

/** The newest-sort hint. Unchanged by this feature (criterion 6). */
export const NEWEST_SORT_SENTENCE = 'Sorted newest first.';

/**
 * The `sort-hint` line.
 *
 * On the popular sort it is two sentences: the unchanged
 * `POPULAR_SORT_SENTENCE` followed by the active window, so the hint NAMES the
 * period (criterion 4) while leaving the capture recipe's waited-on literal
 * intact (criterion 4's other half).
 *
 * On the newest sort it is exactly today's string and carries no period, because
 * the app sends no period there — naming one would assert a filter that is not
 * being applied.
 *
 * 🔴 `period` IS NULLABLE, AND THAT IS THE WHOLE GUARD. Pass `undefined` wherever
 * no window is in effect — the newest sort, and the Mine tab, where the server
 * ignores the window outside public discovery. Naming a window the server is not
 * applying is a claim the viewer has no way to check. When it is `undefined` the
 * hint is byte-for-byte today's string, so those surfaces do not move at all.
 */
export function sortHint(sort: 'newest' | 'popular', period: CollectionPeriod | undefined): string {
  if (sort !== 'popular') return NEWEST_SORT_SENTENCE;
  if (period == null) return POPULAR_SORT_SENTENCE;
  return `${POPULAR_SORT_SENTENCE} ${PERIOD_SENTENCE[period]}`;
}

/**
 * What the grid says once it has run out of pages.
 *
 * Before this feature the grid rendered NOTHING at the end of a list and nobody
 * noticed, because the unwindowed feed pages the whole corpus and a viewer
 * essentially never reaches the end. A Month-default feed ends at ~18 pages, so
 * the end is now a place real viewers arrive at — and a grid that simply stops
 * reads as a broken loader. On a ranked window the line also names the way out
 * (widen the window), which is the actual remedy for "there is nothing more".
 */
export function endOfResultsLabel(sort: 'newest' | 'popular', period: CollectionPeriod | undefined): string {
  if (sort === 'popular' && period != null && isRankedWindow(period)) {
    return `That's the end of ${PERIOD_LABEL[period].toLowerCase()}'s popular collections — pick a longer window for more.`;
  }
  return "That's the end of the results.";
}

// ---------------------------------------------------------------------------
// Did we get the window we asked for?
// ---------------------------------------------------------------------------

/** The provenance fields the list endpoint reports alongside its items. */
export interface ListSourceInfo {
  /** Which store answered — `'clickhouse'` for a ranked window, else `'postgres'`. */
  source?: string;
  /** The wire period the server actually applied (`'Day'`…`'AllTime'`). */
  period?: string;
  /** Why the request did not get what it asked for. */
  sourceReason?: string;
}

/**
 * The note to show when the server could NOT serve the window that was asked
 * for — or `null` when it did.
 *
 * 🔴 THE OBVIOUS TEST IS WRONG: `sourceReason != null` is NOT degradation. A
 * healthy `period=AllTime` request returns `all-time-served-from-postgres`, so
 * keying on the field's presence would warn on the single most ordinary request
 * the feature can make. Measured live — see the table at the top of this file.
 *
 * The question this answers is narrower: we asked for a RANKED window, so did a
 * ranked store answer? Two ways it can be no, both checked:
 *   - the server echoed a DIFFERENT period than the one requested, or
 *   - a store other than ClickHouse answered, i.e. we got the unwindowed order.
 *
 * A host that PREDATES the param sends no `source` at all. That is deliberately
 * treated as "no information", not as a fallback: the card's assumption is that
 * an older deployment degrades to today's behaviour rather than erroring, and
 * warning there would put a permanent scare note under every grid.
 */
export function windowFallbackNotice(
  requested: CollectionPeriod | undefined,
  page: ListSourceInfo | null | undefined,
): string | null {
  if (requested == null) return null;
  // AllTime from Postgres is the design, not a fallback.
  if (!isRankedWindow(requested)) return null;
  if (!page) return null;
  // No provenance reported => a host that predates `period`. Say nothing.
  if (page.source == null) return null;

  const servedADifferentWindow = page.period != null && page.period !== PERIOD_WIRE[requested];
  const servedFromAnUnrankedStore = page.source !== 'clickhouse';
  if (!servedADifferentWindow && !servedFromAnUnrankedStore) return null;

  return `Ranking for ${PERIOD_LABEL[requested].toLowerCase()} isn't available right now — showing all-time popularity instead.`;
}

/**
 * app period -> the server's `MetricTimeframe` spelling.
 *
 * Declared here rather than in lib/api.ts so `windowFallbackNotice` can compare
 * the server's ECHOED period against the requested one without importing the
 * HTTP client. `lib/api.ts` re-exports it as `PERIOD_PARAM`, mirroring
 * `SORT_PARAM`, and `api.test.ts` pins the two spellings against each other.
 */
export const PERIOD_WIRE: Record<CollectionPeriod, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
  allTime: 'AllTime',
};
