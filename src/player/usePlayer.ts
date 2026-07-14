// The React player hook: wraps the pure engine (engine.ts) with playback state,
// image auto-advance timing, and video-loop counting. Element concerns (the
// actual <video>/<img>) stay in the component; this hook decides WHEN to
// advance. It is driven by:
//   - a timer for images (advance after `secondsPerImage` seconds), and
//   - `onVideoEnded()` which the component calls on the <video>'s `ended` event
//     (advance after `videoLoopCount` loops; otherwise signal a replay).
//
// Everything the component needs to render + control is returned, so the hook is
// testable end-to-end via `renderHook` with fake timers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MediaItem } from '../types.js';
import {
  atEnd,
  atStart,
  createPlaylist,
  currentItem,
  goTo,
  goToItemIndex,
  next as engineNext,
  peekNext,
  prev as enginePrev,
  progressLabel,
  shuffleIndices,
  toggleShuffle as engineToggleShuffle,
  type PlaylistState,
  type Rng,
} from './engine.js';

export interface UsePlayerOptions {
  items: readonly MediaItem[];
  secondsPerImage: number;
  videoLoopCount: number;
  /** Start playing immediately once items are present. Default true. */
  autoPlay?: boolean;
  /** Wrap past the ends. Default true. */
  wrap?: boolean;
  /** Injectable RNG for shuffle (tests). */
  rng?: Rng;
  /** Called whenever the current item changes (for analytics / preload logging). */
  onItemChange?: (item: MediaItem | null) => void;
}

export interface UsePlayer {
  state: PlaylistState;
  current: MediaItem | null;
  /** The next item, for preloading. */
  upcoming: MediaItem | null;
  playing: boolean;
  atStart: boolean;
  atEnd: boolean;
  progressLabel: string;
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  toggleShuffle(): void;
  /** Jump to a natural item index. */
  seekToItem(itemIndex: number): void;
  /** Jump to a playback position within the (possibly shuffled) order (scrubber). */
  seekToPosition(position: number): void;
  /**
   * Call from the <video>'s `ended` handler. Returns 'replay' when the video
   * should loop again (component resets currentTime + plays), or 'advance' when
   * the hook advanced to the next item.
   */
  onVideoEnded(): 'replay' | 'advance';
  /** Current 0-based loop the playing video is on (for a "loop 2/3" readout). */
  videoLoop: number;
}

export function usePlayer(opts: UsePlayerOptions): UsePlayer {
  const { items, secondsPerImage, videoLoopCount, onItemChange } = opts;
  const wrap = opts.wrap ?? true;
  const autoPlay = opts.autoPlay ?? true;

  const [state, setState] = useState<PlaylistState>(() => createPlaylist(items, { rng: opts.rng }));
  const [playing, setPlaying] = useState(autoPlay);

  // Loop counter for the currently-showing video. Reset whenever the item changes.
  const videoLoopRef = useRef(0);
  const [videoLoop, setVideoLoop] = useState(0);

  // React to an `items` identity change. Two distinct cases:
  //   - APPEND (progressive load): the new array is the old one with more items
  //     tacked on the end (same prefix by mediaId). Extend the order in place and
  //     KEEP the current position + video-loop counter so streaming in the next
  //     page doesn't yank the viewer back to item 0 or restart the current video.
  //   - REBUILD (a different collection): start fresh at position 0.
  const prevItemsRef = useRef<readonly MediaItem[]>(items);
  useEffect(() => {
    const prevItems = prevItemsRef.current;
    prevItemsRef.current = items;
    const prevLen = prevItems.length;
    const isAppend =
      items !== prevItems &&
      items.length > prevLen &&
      prevLen > 0 &&
      prevItems.every((it, i) => items[i]?.mediaId === it.mediaId);
    if (isAppend) {
      setState((prev) => {
        const newIndices = Array.from({ length: items.length - prev.items.length }, (_, k) => prev.items.length + k);
        // Preserve the shuffled feel: shuffle only the freshly-added block and
        // append it after the existing order (natural order appends verbatim).
        const extra = prev.shuffled
          ? shuffleIndices(newIndices.length, opts.rng).map((k) => newIndices[k])
          : newIndices;
        return { ...prev, items, order: [...prev.order, ...extra] };
      });
      return; // keep position + video-loop counter
    }
    setState((prev) => createPlaylist(items, { shuffle: prev.shuffled, rng: opts.rng }));
    videoLoopRef.current = 0;
    setVideoLoop(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const current = useMemo(() => currentItem(state), [state]);
  const upcoming = useMemo(() => peekNext(state, wrap), [state, wrap]);

  // Reset the video loop counter every time the shown item changes.
  const currentId = current?.mediaId ?? null;
  useEffect(() => {
    videoLoopRef.current = 0;
    setVideoLoop(0);
    onItemChange?.(current ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const advance = useCallback(() => {
    setState((prev) => engineNext(prev, wrap));
  }, [wrap]);

  // Image auto-advance: a single timeout re-armed whenever we're playing an
  // image. Videos are advanced by `onVideoEnded`, so no timer for them.
  useEffect(() => {
    if (!playing) return;
    if (!current || current.type !== 'image') return;
    const ms = Math.max(1, secondsPerImage) * 1000;
    const id = setTimeout(advance, ms);
    return () => clearTimeout(id);
  }, [playing, current, currentId, secondsPerImage, advance]);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => setPlaying((p) => !p), []);

  const goNext = useCallback(() => setState((prev) => engineNext(prev, wrap)), [wrap]);
  const goPrev = useCallback(() => setState((prev) => enginePrev(prev, wrap)), [wrap]);
  const doToggleShuffle = useCallback(
    () => setState((prev) => engineToggleShuffle(prev, opts.rng)),
    [opts.rng],
  );
  const seekToItem = useCallback(
    (itemIndex: number) => setState((prev) => goToItemIndex(prev, itemIndex)),
    [],
  );
  const seekToPosition = useCallback(
    (position: number) => setState((prev) => goTo(prev, position)),
    [],
  );

  const onVideoEnded = useCallback((): 'replay' | 'advance' => {
    videoLoopRef.current += 1;
    if (videoLoopRef.current < Math.max(1, videoLoopCount)) {
      setVideoLoop(videoLoopRef.current);
      return 'replay';
    }
    videoLoopRef.current = 0;
    setVideoLoop(0);
    if (playing) {
      setState((prev) => engineNext(prev, wrap));
    }
    return 'advance';
  }, [videoLoopCount, playing, wrap]);

  return {
    state,
    current,
    upcoming,
    playing,
    atStart: atStart(state),
    atEnd: atEnd(state),
    progressLabel: progressLabel(state),
    play,
    pause,
    toggle,
    next: goNext,
    prev: goPrev,
    toggleShuffle: doToggleShuffle,
    seekToItem,
    seekToPosition,
    onVideoEnded,
    videoLoop,
  };
}
