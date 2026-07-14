// Discover / My-collections grid + the cross-user "Popular" rail. Pure
// presentation: it takes already-loaded data and callbacks. All loading /
// error / empty states are rendered here so every list surface handles them.

import { useState } from 'react';
import type { CSSProperties } from 'react';

import type { CollectionSummary } from '../types.js';
import type { Palette } from '../theme.js';

/**
 * Cover thumbnail with a graceful placeholder (feedback #2). Renders the ▶
 * placeholder tile when there is no `src` AND when the image fails to load
 * (broken/expired URL), so a card is never blank or shows a broken-image icon.
 */
export function CoverImage({ src, c }: { src: string | null; c: Palette }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div style={coverPlaceholder(c)} aria-hidden="true" data-testid="cover-placeholder">
        ▶
      </div>
    );
  }
  return (
    // eslint-disable-next-line jsx-a11y/img-redundant-alt
    <img src={src} alt="" style={coverImg} loading="lazy" onError={() => setFailed(true)} />
  );
}

export interface CollectionGridProps {
  collections: CollectionSummary[];
  loading: boolean;
  error: string | null;
  emptyLabel: string;
  onOpen: (collection: CollectionSummary) => void;
  onRetry?: () => void;
  c: Palette;
  isMobile: boolean;
}

export function CollectionGrid({
  collections,
  loading,
  error,
  emptyLabel,
  onOpen,
  onRetry,
  c,
  isMobile,
}: CollectionGridProps) {
  if (loading && collections.length === 0) {
    return (
      <div style={noteStyle(c)} data-testid="grid-loading" role="status">
        Loading collections…
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" data-testid="grid-error" style={errorBox(c)}>
        <p style={{ margin: 0 }}>{error}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} style={retryBtn(c)} data-testid="grid-retry">
            Try again
          </button>
        )}
      </div>
    );
  }
  if (collections.length === 0) {
    return (
      <p style={noteStyle(c)} data-testid="grid-empty">
        {emptyLabel}
      </p>
    );
  }
  return (
    <ul
      style={gridStyle(isMobile)}
      data-testid="collection-grid"
      data-layout={isMobile ? 'mobile' : 'desktop'}
    >
      {collections.map((col) => (
        <li key={col.id} style={{ listStyle: 'none' }}>
          <CollectionCard collection={col} onOpen={onOpen} c={c} />
        </li>
      ))}
    </ul>
  );
}

export function CollectionCard({
  collection,
  onOpen,
  c,
}: {
  collection: CollectionSummary;
  onOpen: (collection: CollectionSummary) => void;
  c: Palette;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(collection)}
      style={cardBtn(c)}
      data-testid="collection-card"
      aria-label={`Play ${collection.name} — ${collection.itemCount} items`}
    >
      <div style={coverWrap(c)}>
        <CoverImage src={collection.coverImageUrl} c={c} />
        {!collection.isPublic && (
          <span style={privateBadge(c)} data-testid="private-badge">
            Private
          </span>
        )}
        {collection.followed && (
          <span style={followedBadge(c)} data-testid="followed-badge" aria-label="Followed">
            ★
          </span>
        )}
      </div>
      <div style={cardBody}>
        <span style={cardTitle}>{collection.name}</span>
        <span style={cardMeta(c)}>
          {collection.curator.username ? `by ${collection.curator.username}` : 'by unknown'} ·{' '}
          {collection.itemCount} {collection.itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>
    </button>
  );
}

export interface PopularRailProps {
  entries: Array<{ collection: CollectionSummary; count: number }>;
  onOpen: (collection: CollectionSummary) => void;
  c: Palette;
}

export function PopularRail({ entries, onOpen, c }: PopularRailProps) {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Popular collections" data-testid="popular-rail" style={{ display: 'grid', gap: 8 }}>
      <h2 style={railHeading}>🔥 Popular right now</h2>
      <div style={railScroller}>
        {entries.map(({ collection, count }) => (
          <button
            key={collection.id}
            type="button"
            onClick={() => onOpen(collection)}
            style={railCard(c)}
            data-testid="popular-card"
            aria-label={`Play ${collection.name} — played ${count} times`}
          >
            <div style={railCover(c)}>
              <CoverImage src={collection.coverImageUrl} c={c} />
            </div>
            <span style={railTitle}>{collection.name}</span>
            <span style={cardMeta(c)}>{count} plays</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---- styles ----
function gridStyle(isMobile: boolean): CSSProperties {
  return {
    display: 'grid',
    gap: 12,
    padding: 0,
    margin: 0,
    gridTemplateColumns: isMobile
      ? 'repeat(2, minmax(0, 1fr))'
      : 'repeat(auto-fill, minmax(190px, 1fr))',
  };
}

function cardBtn(c: Palette): CSSProperties {
  return {
    display: 'grid',
    gap: 8,
    width: '100%',
    padding: 0,
    border: '1px solid ' + c.border,
    borderRadius: 12,
    overflow: 'hidden',
    background: c.card,
    color: c.fg,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  };
}

function coverWrap(c: Palette): CSSProperties {
  return {
    position: 'relative',
    aspectRatio: '1 / 1',
    background: c.inputBg,
    overflow: 'hidden',
  };
}

const coverImg: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };

function coverPlaceholder(c: Palette): CSSProperties {
  return {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: c.muted,
    fontSize: 28,
  };
}

function privateBadge(c: Palette): CSSProperties {
  return {
    position: 'absolute',
    top: 6,
    left: 6,
    background: c.overlay,
    color: '#fff',
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 999,
  };
}

function followedBadge(c: Palette): CSSProperties {
  return {
    position: 'absolute',
    top: 6,
    right: 6,
    background: c.accent,
    color: c.accentFg,
    fontSize: 12,
    width: 22,
    height: 22,
    borderRadius: 999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}

const cardBody: CSSProperties = { display: 'grid', gap: 2, padding: '0 10px 10px' };
const cardTitle: CSSProperties = {
  fontWeight: 700,
  fontSize: 14,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
function cardMeta(c: Palette): CSSProperties {
  return { fontSize: 12, color: c.muted };
}

const railHeading: CSSProperties = { fontSize: 15, margin: 0 };
const railScroller: CSSProperties = {
  display: 'flex',
  gap: 10,
  overflowX: 'auto',
  paddingBottom: 4,
  WebkitOverflowScrolling: 'touch',
};
function railCard(c: Palette): CSSProperties {
  return {
    flex: '0 0 auto',
    width: 140,
    display: 'grid',
    gap: 4,
    padding: 8,
    border: '1px solid ' + c.border,
    borderRadius: 10,
    background: c.card,
    color: c.fg,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  };
}
function railCover(c: Palette): CSSProperties {
  return { aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', background: c.inputBg };
}
const railTitle: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function noteStyle(c: Palette): CSSProperties {
  return { fontSize: 14, color: c.muted, margin: 0, lineHeight: 1.5 };
}
function errorBox(c: Palette): CSSProperties {
  return {
    background: c.dangerBg,
    color: c.danger,
    border: '1px solid ' + c.danger,
    borderRadius: 8,
    padding: 12,
    fontSize: 13,
    display: 'grid',
    gap: 8,
    justifyItems: 'start',
  };
}
function retryBtn(c: Palette): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid ' + c.danger,
    background: 'transparent',
    color: c.danger,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}
