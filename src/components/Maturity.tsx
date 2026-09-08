// Maturity chrome: a rating badge, and nothing else.
//
// 🔴 THE REVEAL OVERLAY THAT LIVED HERE IS GONE, AND MUST NOT COME BACK. It
// asked the viewer to confirm they were 18+ and then unblurred mature media — an
// app-local consent mechanism re-asking a question the platform has already
// answered through the viewer's own NSFW browsing level. Content above that
// ceiling is not blurred now, it is not rendered; see ../lib/maturity.ts.
// `src/deleted-mature-gate.test.ts` fails if any of it returns.
//
// A badge is not a gate: it LABELS content the ceiling already permits.

import type { CSSProperties } from 'react';

import { hasMaturityBadge, maturityLabel } from '../lib/maturity.js';

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
