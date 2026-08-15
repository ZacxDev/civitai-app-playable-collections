// Maturity chrome: a rating badge + a blur-until-tap reveal overlay, driven by a
// media item's `nsfwLevel` (see ../lib/maturity.ts). Presentation only.

import type { CSSProperties } from 'react';

import { hasMaturityBadge, maturityLabel } from '../lib/maturity.js';

/** Blur strength (px) applied to a mature, not-yet-revealed media element. */
export const MATURITY_BLUR_PX = 36;

/** A small rating pill (e.g. `R`, `XXX`). Renders nothing for plain PG content. */
export function MaturityBadge({ nsfwLevel, style }: { nsfwLevel: number; style?: CSSProperties }) {
  if (!hasMaturityBadge(nsfwLevel)) return null;
  const label = maturityLabel(nsfwLevel);
  return (
    <span data-testid="maturity-badge" data-rating={label} style={{ ...badgeStyle, ...style }} aria-label={`Maturity rating ${label}`}>
      {label}
    </span>
  );
}

/**
 * Full-surface SESSION-LEVEL maturity gate shown over a blurred mature item.
 * Accepting it once (click / Enter / Space) unblurs the whole playthrough for the
 * rest of the session — see ../lib/mature-session.ts — instead of re-asking per
 * item. Fail-closed: the media stays blurred until the viewer accepts.
 */
export function MaturityRevealOverlay({ nsfwLevel, onReveal }: { nsfwLevel: number; onReveal: () => void }) {
  const label = maturityLabel(nsfwLevel);
  return (
    <button
      type="button"
      onClick={onReveal}
      style={overlayStyle}
      data-testid="maturity-reveal"
      aria-label="I'm 18 or older — reveal this collection"
    >
      <span aria-hidden="true" style={{ fontSize: 26 }}>
        🔞
      </span>
      <span style={{ fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600 }}>I&rsquo;m 18+ — reveal this collection</span>
      <span style={{ fontSize: 12, opacity: 0.85 }}>Unblurs mature media for the rest of this session</span>
    </button>
  );
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 7px',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0.4,
  lineHeight: 1.4,
  color: '#fff',
  background: 'rgba(224,49,49,0.92)',
  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
};

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  border: 'none',
  cursor: 'pointer',
  color: '#fff',
  background: 'rgba(0,0,0,0.35)',
  zIndex: 4,
  fontFamily: 'inherit',
};
