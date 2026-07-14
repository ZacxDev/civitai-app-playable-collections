// Pure "which videos may autoplay right now" decision for the continuous feeds.
//
// Many videos can be on screen at once; autoplaying them all would melt the
// device. The rule (Feature 4): autoplay muted ONLY while a video is in-viewport
// AND under a concurrency cap (~4-6). Everything else shows its poster/first
// frame. Extracting the decision as a pure function over (the in-view set, the
// cap, a priority order) makes the perf guard unit-testable without a real
// IntersectionObserver or <video>.

/** Default max simultaneously-playing videos. Tuned to the "~4-6" perf guard. */
export const DEFAULT_AUTOPLAY_CAP = 5;

/**
 * Choose which media may play. `inViewOrdered` is the list of in-viewport video
 * mediaIds in PRIORITY order (the caller sorts it — e.g. top-to-bottom document
 * order, or distance-to-viewport-center). The first `cap` of them win; the rest
 * are held on their poster. Pure + deterministic.
 *
 * Dedupes ids and ignores a non-positive cap (→ nothing plays).
 */
export function selectPlayable(inViewOrdered: readonly number[], cap: number = DEFAULT_AUTOPLAY_CAP): Set<number> {
  const playing = new Set<number>();
  if (!(cap > 0)) return playing;
  for (const id of inViewOrdered) {
    if (playing.has(id)) continue;
    playing.add(id);
    if (playing.size >= cap) break;
  }
  return playing;
}

/**
 * Convenience predicate over the result of `selectPlayable`. A video plays when
 * it is in the chosen set; otherwise it shows its poster. Kept separate so a
 * component can compute the set once per frame and ask per-tile.
 */
export function mayPlay(playable: ReadonlySet<number>, mediaId: number): boolean {
  return playable.has(mediaId);
}
