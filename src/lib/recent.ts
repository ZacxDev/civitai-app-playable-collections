// Recently-played collections (Feature #7).
//
// A device-local, most-recent-first list of collections the viewer has opened,
// so the home screen can offer a "Continue watching" rail. Each entry keeps just
// what the rail card needs (id + name + cover); the SAVED playback mode/position
// still lives in view-modes.ts (loadCollectionState), so reopening resumes
// exactly where the viewer left off with no extra bookkeeping here.

import { useCallback, useState } from 'react';

import { getLocalStorage } from '../settings.js';

export interface RecentEntry {
  id: number;
  name: string;
  coverImageUrl: string | null;
}

export const MAX_RECENT = 12;
const KEY = 'playable-collections:recent';

function isRecentEntry(v: unknown): v is RecentEntry {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { id?: unknown }).id === 'number' &&
    typeof (v as { name?: unknown }).name === 'string'
  );
}

/** The recently-played list, most-recent-first. Missing/corrupt → empty. */
export function readRecent(storage: Storage | null = getLocalStorage()): RecentEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecentEntry)
      .map((e) => ({ id: e.id, name: e.name, coverImageUrl: e.coverImageUrl ?? null }))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Record a played collection at the FRONT (dedup by id, capped). Returns the new list. */
export function recordRecent(
  summary: { id: number; name: string; coverImageUrl: string | null },
  storage: Storage | null = getLocalStorage(),
): RecentEntry[] {
  const entry: RecentEntry = { id: summary.id, name: summary.name, coverImageUrl: summary.coverImageUrl ?? null };
  const next = [entry, ...readRecent(storage).filter((e) => e.id !== entry.id)].slice(0, MAX_RECENT);
  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

/** Hook: the recently-played list + a `record` setter to call on open. */
export function useRecent(storage: Storage | null = getLocalStorage()): {
  recent: RecentEntry[];
  record: (summary: { id: number; name: string; coverImageUrl: string | null }) => void;
} {
  const [recent, setRecent] = useState<RecentEntry[]>(() => readRecent(storage));
  const record = useCallback(
    (summary: { id: number; name: string; coverImageUrl: string | null }) => {
      setRecent(recordRecent(summary, storage));
    },
    [storage],
  );
  return { recent, record };
}
