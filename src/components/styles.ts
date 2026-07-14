// Bespoke inline-style builder for the media player's overlay transport
// controls. The `@civitai/blocks-react/ui` pack has no media-player primitives
// (play/pause/next, follow/bookmark, tip), so these round icon buttons sit on a
// dark, translucent media surface and are hand-styled to sit alongside the
// pack's Button idiom. (Listed as a component-pack gap in the v0.1.5 report.)

import type { CSSProperties } from 'react';

import type { Palette } from '../theme.js';

/** A round icon control used for the player overlay chrome. */
export function iconBtn(c: Palette, active = false, disabled = false): CSSProperties {
  return {
    width: 44,
    height: 44,
    minWidth: 44,
    borderRadius: 999,
    border: '1px solid rgba(255,255,255,0.25)',
    background: active ? c.accent : 'rgba(0,0,0,0.45)',
    color: active ? c.accentFg : '#fff',
    fontSize: 18,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
    lineHeight: 1,
  };
}
