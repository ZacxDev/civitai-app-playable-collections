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
 * Full-surface tap-to-reveal overlay shown over a blurred mature item. Clicking
 * it (or pressing Enter/Space, since it's a button) reveals the media.
 */
export function MaturityRevealOverlay({ nsfwLevel, onReveal }: { nsfwLevel: number; onReveal: () => void }) {
  const label = maturityLabel(nsfwLevel);
  return (
    <button type="button" onClick={onReveal} style={overlayStyle} data-testid="maturity-reveal" aria-label={`Reveal ${label}-rated media`}>
      <span aria-hidden="true" style={{ fontSize: 26 }}>
        🔞
      </span>
      <span style={{ fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 13, opacity: 0.85 }}>Tap to reveal</span>
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
