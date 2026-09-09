// Bespoke inline-style builder for the media player's overlay transport
// controls. The `@civitai/blocks-react/ui` pack has no media-player primitives
// (play/pause/next, follow/bookmark, tip), so these round icon buttons sit on a
// dark, translucent media surface and are hand-styled to sit alongside the
// pack's Button idiom. (Listed as a component-pack gap in the v0.1.5 report.)

import type { CSSProperties } from 'react';

import { stage, type Palette } from '../theme.js';

/**
 * A round icon control used for the player overlay chrome.
 *
 * 🔴 EVERY COLOUR COMES FROM A TOKEN — none is written here. Until 0.2.15 this
 * function carried its own literals, which made it a SECOND COPY of the `stage`
 * group in `../theme.js`, and the two had already drifted: the border was
 * `rgba(255,255,255,0.25)` here against `stage.chromeBtnBorder`'s
 * `rgba(255,255,255,0.28)`. One rule in two places disagrees eventually; this is
 * what that looks like when nothing asserts on it.
 *
 * 🔴 THE OVER-MEDIA COLOURS ARE THEME-INVARIANT ON PURPOSE, AND THAT IS NOT AN
 * OVERSIGHT TO "FIX". A full-bleed player letterboxes on black and overlays
 * white-on-scrim chrome whatever the host theme is, because these controls sit on
 * ARBITRARY USER MEDIA rather than on the page background — a control tinted to a
 * light theme would vanish on a bright image. `../theme.js`'s `stage` group says
 * this in its own header; the point of this change is that the values now come
 * from there instead of being re-typed.
 *
 * The ACTIVE state is the deliberate exception: it uses the theme's `primary`
 * pair (`c.accent` / `c.accentFg`), so a pressed control picks up the app's brand
 * and does vary by theme. That is the one place a token SHOULD move here.
 */
export function iconBtn(c: Palette, active = false, disabled = false): CSSProperties {
  return {
    width: 44,
    height: 44,
    minWidth: 44,
    borderRadius: 999,
    border: `1px solid ${stage.chromeBtnBorder}`,
    background: active ? c.accent : stage.chromeBtnBg,
    color: active ? c.accentFg : stage.chromeFg,
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
