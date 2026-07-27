// Discover / My-collections grid + the cross-user "Popular" rail. Pure
// presentation: it takes already-loaded data and callbacks. All loading /
// error / empty states are rendered here so every list surface handles them.
// Chrome is design-system: pack Loader / Alert / Button / Badge + EmptyState,
// all off `--civitai-*` tokens (via ../theme); the media cards are custom
// (the pack has no image-card control) but token-styled with real hover/focus
// states from `.pc-card` in index.css.

import type { CSSProperties } from 'react';

import { Alert, Badge, Button, Loader } from '@civitai/blocks-react/ui';

import type { CollectionSummary } from '../types.js';
import { metaText, mutedText, radius, token, type Palette } from '../theme.js';
import { EmptyState } from './EmptyState.js';

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
      <div
        data-testid="grid-loading"
        role="status"
        aria-live="polite"
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 4px' }}
      >
        <Loader size="sm" />
        <span style={mutedText}>Loading collections…</span>
      </div>
    );
  }
  if (error) {
    return (
      <Alert
        color="error"
        role="alert"
        data-testid="grid-error"
        title="Couldn't load collections"
      >
        <div style={{ display: 'grid', gap: 10, justifyItems: 'start' }}>
          <span style={{ ...metaText, color: 'inherit' }}>{error}</span>
          {onRetry && (
            <Button
              variant="light"
              color="error"
              size="sm"
              onClick={onRetry}
              data-testid="grid-retry"
            >
              Try again
            </Button>
          )}
        </div>
      </Alert>
    );
  }
  if (collections.length === 0) {
    return <EmptyState title={emptyLabel} data-testid="grid-empty" />;
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
      className="pc-card"
      onClick={() => onOpen(collection)}
      style={cardBtn(c)}
      data-testid="collection-card"
      aria-label={`Play ${collection.name} — ${collection.itemCount} ${collection.itemCount === 1 ? 'item' : 'items'}`}
    >
      <div style={coverWrap(c)}>
        {collection.coverImageUrl ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img src={collection.coverImageUrl} alt="" className="pc-cover-img" style={coverImg} loading="lazy" />
        ) : (
          <div style={coverPlaceholder(c)} aria-hidden="true">
            ▶
          </div>
        )}
        {!collection.isPublic && (
          <Badge
            variant="filled"
            color="warning"
            size="sm"
            data-testid="private-badge"
            style={badgePos('left')}
          >
            Private
          </Badge>
        )}
        {collection.followed && (
          <Badge
            variant="filled"
            color="primary"
            size="sm"
            data-testid="followed-badge"
            aria-label="Followed"
            style={badgePos('right')}
          >
            ★
          </Badge>
        )}
      </div>
      <div style={cardBody}>
        <span style={cardTitle}>{collection.name}</span>
        <span style={{ ...metaText }}>
          {collection.curator.username ? `by ${collection.curator.username}` : 'by unknown'} ·{' '}
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{collection.itemCount}</span>{' '}
          {collection.itemCount === 1 ? 'item' : 'items'}
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
    <section aria-label="Popular collections" data-testid="popular-rail" style={{ display: 'grid', gap: 10 }}>
      <h2 style={railHeading}>Popular right now</h2>
      <div style={railScroller}>
        {entries.map(({ collection, count }) => (
          <button
            key={collection.id}
            type="button"
            className="pc-card"
            onClick={() => onOpen(collection)}
            style={railCard(c)}
            data-testid="popular-card"
            aria-label={`Play ${collection.name} — played ${count} ${count === 1 ? 'time' : 'times'}`}
          >
            <div style={railCover(c)}>
              {collection.coverImageUrl ? (
                <img src={collection.coverImageUrl} alt="" className="pc-cover-img" style={coverImg} loading="lazy" />
              ) : (
                <div style={coverPlaceholder(c)} aria-hidden="true">
                  ▶
                </div>
              )}
            </div>
            <span style={railTitle}>{collection.name}</span>
            <span style={metaText}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{count.toLocaleString()}</span>{' '}
              {count === 1 ? 'play' : 'plays'}
            </span>
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
    gap: 14,
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
    border: `1px solid ${c.border}`,
    borderRadius: radius.lg,
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
    background: c.recess,
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

function badgePos(side: 'left' | 'right'): CSSProperties {
  return { position: 'absolute', top: 6, [side]: 6 };
}

const cardBody: CSSProperties = { display: 'grid', gap: 3, padding: '0 10px 10px' };
const cardTitle: CSSProperties = {
  fontWeight: 700,
  fontSize: 14,
  color: token.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const railHeading: CSSProperties = { fontSize: 15, margin: 0, color: token.text, letterSpacing: '-0.01em' };
const railScroller: CSSProperties = {
  display: 'flex',
  gap: 12,
  overflowX: 'auto',
  paddingBottom: 4,
  WebkitOverflowScrolling: 'touch',
};
function railCard(c: Palette): CSSProperties {
  return {
    flex: '0 0 auto',
    width: 148,
    display: 'grid',
    gap: 6,
    padding: 8,
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    background: c.card,
    color: c.fg,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  };
}
function railCover(c: Palette): CSSProperties {
  return { aspectRatio: '1 / 1', borderRadius: radius.sm, overflow: 'hidden', background: c.recess };
}
const railTitle: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  color: token.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
