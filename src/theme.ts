// Design tokens for Playable Collections.
//
// Every THEME value resolves to a CSS custom property (`--civitai-*`) — light/dark
// is driven entirely by the
// `[data-theme]` attribute on the block root (see App.tsx / CollectionViewer.tsx
// / Player.tsx). The `@civitai/blocks-react/ui` pack (Button/Badge/Modal/…) is
// self-themed off the same tokens, so the app's own chrome reads as one system.
//
// 🔴 WHO SUPPLIES THOSE TOKEN VALUES CHANGED IN 0.2.9. This app is now
// `brandDepth: skin`, not `accent`: `@civitai/theme@0.3.1` still DECLARES the
// tokens (and `@property`-registers them), but **src/skin.css overrides their
// values** from the brand plate `#FA6478` for both themes. So this module is
// unchanged — it just resolves to the app's palette rather than the platform's.
// ⚠ "literal-free" was this file's own claim about itself and it is FALSE: `stage`
// below carries seven literals. They are theme-INVARIANT by design and documented
// as such, which is a different statement from "there are none"; src/skin.test.ts
// now lists this file as a colour-literal carrier, so the two agree. Read src/skin.css before reasoning about any colour below;
// its selectors are (0,2,0) and beat the package's (0,1,0) blocks.
//
// Token names: the pre-0.35 pack emitted `--ci-*`; 0.35.2+ emits `--civitai-*` and
// nothing at `--ci-*`, so every legacy `--ci-*` reference has been migrated here
// (a bare `--ci-*` now resolves to NOTHING → invisible chrome).
//
// 🔴 Two token traps this module used to work around — BOTH RETIRED BY THE SKIN,
// recorded because the workarounds are still visible in the code below and read
// as superstition without this note:
//   1. The `--civitai-color-gray-*` ramp is theme-INVARIANT upstream (not
//      redefined under [data-theme='dark']). Still true, and still never used by
//      THIS MODULE. ⚠ But "the skin does not override the ramp either, so the
//      hazard is intact" — which this comment said until an audit — was wrong
//      about the app: @civitai/components consumes the ramp, so a pack Slider
//      painted platform blue-grey on a rose surface. src/skin.css now defines the
//      four ramp tokens the pack references. Avoiding a token is not the same as
//      that token being unreachable, and the difference is a dependency you did
//      not write.
//   2. In LIGHT theme upstream, `body == surface == surface-2` (all `#fefefe`), so
//      a card got NO fill contrast. FIXED: the skin gives light three distinct
//      values (`#fbf1f3` / `#ffffff` / `#f4e3e7`), asserted with a minimum
//      separation in both themes by src/skin.test.ts. `elevate()` below is kept
//      anyway — it is a *relative* tint, so it still reads correctly against
//      whatever surface it lands on, which a fixed token cannot promise.

import type { CSSProperties } from 'react';

/** The theme-aware `--civitai-*` tokens this app consumes (all flip with `[data-theme]`). */
export const token = {
  text: 'var(--civitai-color-text)',
  dimmed: 'var(--civitai-color-text-dimmed)',
  body: 'var(--civitai-color-body)',
  surface: 'var(--civitai-color-surface)',
  surface2: 'var(--civitai-color-surface-2)',
  border: 'var(--civitai-color-border)',
  primary: 'var(--civitai-color-primary)',
  primaryFg: 'var(--civitai-color-primary-fg)',
  primaryLight: 'var(--civitai-color-primary-light)',
  error: 'var(--civitai-color-error)',
  success: 'var(--civitai-color-success)',
  warning: 'var(--civitai-color-warning)',
  radius: 'var(--civitai-radius)',
  font: 'var(--civitai-font)',
} as const;

/** `--civitai-radius` (0.25rem) and its common multiples, as strings. */
export const radius = {
  sm: token.radius,
  md: `calc(${token.radius} * 2)`,
  lg: `calc(${token.radius} * 3)`,
  pill: '999px',
} as const;

/**
 * A subtle, theme-agnostic elevation tint derived from the tokens: mix a little
 * `text` into `surface`. Works in BOTH themes (in light this darkens white; in
 * dark it lightens the panel) without touching the invariant gray ramp.
 *
 * It originally existed because `surface-2` was useless in light — upstream it is
 * identical to `body` there. The skin fixed that, so `surface-2` is now a real
 * recess token and IS used for inert chrome. `elevate()` survives for the
 * different job it was always doing better: a tint RELATIVE to whatever surface it
 * sits on, which a fixed token cannot be.
 */
export function elevate(pct: number): string {
  return `color-mix(in srgb, var(--civitai-color-text) ${pct}%, var(--civitai-color-surface))`;
}

/** A token-derived semantic tint (e.g. a faint error/success wash) for both themes. */
export function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, var(--civitai-color-surface))`;
}

// --- media-player chrome (theme-INVARIANT by design) --------------------------
// A full-bleed media player letterboxes on black and overlays white-on-scrim
// chrome regardless of the host theme (like every video player). These are NOT
// theme tokens on purpose — they must read against arbitrary user media, not the
// page background — so they use CSS color keywords / rgba, never a hardcoded hex.
export const stage = {
  bg: 'black',
  scrim: 'rgba(0, 0, 0, 0.55)',
  chromeFg: 'white',
  chromeFgDim: 'rgba(255, 255, 255, 0.82)',
  chromeBtnBg: 'rgba(0, 0, 0, 0.45)',
  chromeBtnBorder: 'rgba(255, 255, 255, 0.28)',
  textShadow: '0 1px 3px rgba(0, 0, 0, 0.8)',
} as const;

/**
 * The app-chrome palette, entirely as `--civitai-*` var references (theme-agnostic
 * — light/dark resolves at render off `[data-theme]`, no JS boolean). Kept in this
 * shape so components can thread a single `c` object (and tests pass one) while the
 * values are pure design-system tokens.
 */
export interface Palette {
  bg: string;
  fg: string;
  card: string;
  border: string;
  recess: string;
  accent: string;
  accentFg: string;
  danger: string;
  success: string;
  muted: string;
  chipBg: string;
  chipActiveBg: string;
  overlay: string;
  stageBg: string;
  chromeFg: string;
}

export function palette(): Palette {
  return {
    bg: token.body,
    fg: token.text,
    card: token.surface,
    border: token.border,
    recess: elevate(4), // faint recess for cover placeholders / inert surfaces
    accent: token.primary,
    accentFg: token.primaryFg,
    danger: token.error,
    success: token.success,
    muted: token.dimmed,
    chipBg: elevate(6),
    chipActiveBg: token.primary,
    overlay: stage.scrim,
    stageBg: stage.bg,
    chromeFg: stage.chromeFg,
  };
}

// --- shared page scaffolding --------------------------------------------------
export function pageStyle(c: Palette): CSSProperties {
  return {
    fontFamily: token.font,
    background: c.bg,
    color: c.fg,
    width: '100%',
    minHeight: '100dvh',
    display: 'flex',
    boxSizing: 'border-box',
  };
}

export const contentStyle: CSSProperties = {
  margin: '0 auto',
  width: '100%',
  maxWidth: 980,
  padding: 'clamp(14px, 3vw, 24px)',
  boxSizing: 'border-box',
};

/** Muted secondary text — the dimmed token at full opacity (crisper than opacity-stacking). */
export const mutedText: CSSProperties = { color: token.dimmed, fontSize: 13, lineHeight: 1.5 };

/** Smaller meta/caption text. */
export const metaText: CSSProperties = { color: token.dimmed, fontSize: 12, lineHeight: 1.45 };

/** Tabular numerals for counts that update in place (balances, plays, item counts). */
export const tnum: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
