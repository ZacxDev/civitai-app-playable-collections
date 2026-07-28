// Deep-link state <-> URL encoding (Feature #6).
//
// A played collection is linkable: the open collection id + view mode + item
// index live in the URL hash so a reload restores exactly where the viewer was,
// and a Share button hands out a link that opens straight into playback.
//
// We use the HASH (not the query) so the block controls its own address without
// a navigation/reload, and keep the shape tiny + human-legible:
//   #c=<collectionId>&mode=<mode>&i=<index>
// `mode` is omitted when it's the default (classic); `i` is omitted when 0.

import { DEFAULT_VIEW_MODE, isViewMode, type ViewMode } from '../view-modes.js';

export interface DeepLinkState {
  collectionId: number;
  mode: ViewMode;
  /** Item index within the collection (classic playback position). */
  index: number;
}

/** Encode a deep-link state to a hash string (WITHOUT the leading `#`). */
export function encodeDeepLink(state: DeepLinkState): string {
  const parts: string[] = [`c=${encodeURIComponent(String(state.collectionId))}`];
  if (state.mode && state.mode !== DEFAULT_VIEW_MODE) parts.push(`mode=${encodeURIComponent(state.mode)}`);
  if (state.index > 0) parts.push(`i=${encodeURIComponent(String(Math.floor(state.index)))}`);
  return parts.join('&');
}

/**
 * Decode a hash/query string to a deep-link state, or null when there's no valid
 * collection id. Tolerates a leading `#`/`?`, unknown params, a bad mode
 * (→ default), and a non-finite/negative index (→ 0). Never throws.
 */
export function decodeDeepLink(raw: string | null | undefined): DeepLinkState | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^[#?]/, '');
  if (!cleaned) return null;
  const params = new URLSearchParams(cleaned);
  const idRaw = params.get('c');
  if (idRaw == null) return null;
  const collectionId = Number(idRaw);
  if (!Number.isFinite(collectionId) || collectionId <= 0) return null;
  const modeRaw = params.get('mode');
  const mode = isViewMode(modeRaw) ? modeRaw : DEFAULT_VIEW_MODE;
  const idxRaw = Number(params.get('i'));
  const index = Number.isFinite(idxRaw) && idxRaw > 0 ? Math.floor(idxRaw) : 0;
  return { collectionId, mode, index };
}

/** Build a full shareable URL from a base (origin+path) and a deep-link state. */
export function buildShareUrl(base: string, state: DeepLinkState): string {
  const [withoutHash] = base.split('#');
  return `${withoutHash}#${encodeDeepLink(state)}`;
}
