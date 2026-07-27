// Media-player overlay chrome. The round transport/overlay buttons sit on top of
// arbitrary user media (images/videos), so — like every video player — they are
// deliberately white-on-scrim and theme-INVARIANT (they must read against the
// media, not the page background), sourced from the `stage.*` chrome constants,
// not the theme tokens. Every page-surface control uses the `@civitai/blocks-react`
// pack instead; this is the one carve-out the pack doesn't cover.

import type { CSSProperties } from 'react';

import { stage, token } from '../theme.js';

/** A round icon control used for the player overlay chrome. */
export function iconBtn(active = false, disabled = false): CSSProperties {
  return {
    width: 44,
    height: 44,
    minWidth: 44,
    borderRadius: 999,
    border: `1px solid ${active ? token.primary : stage.chromeBtnBorder}`,
    background: active ? token.primary : stage.chromeBtnBg,
    color: active ? token.primaryFg : stage.chromeFg,
    fontSize: 18,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
    lineHeight: 1,
    transition: 'background 120ms ease, border-color 120ms ease, transform 80ms ease',
  };
}
