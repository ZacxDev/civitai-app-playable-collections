// Design tokens for Playable Collections.
//
// Every value resolves to a `@civitai/theme` CSS custom property (`--civitai-*`)
// so there are ZERO hardcoded theme colors and light/dark is driven entirely by
// the `[data-theme]` attribute the host sets on the block root (see App.tsx /
// CollectionViewer.tsx / Player.tsx). The `@civitai/blocks-react/ui` pack
// (Button/Badge/Modal/…) is self-themed off the same tokens, so the app's own
// chrome reads as one system.
//
// Token source: `@civitai/theme@0.2.0` — imported once in main.tsx via
// `@civitai/theme/styles.css` (and also injected at runtime by the pack's
// injectBlocksStyles()). The pre-0.35 pack emitted `--ci-*` tokens; 0.35.2 emits
// `--civitai-*` and nothing at `--ci-*`, so every legacy `--ci-*` reference has
// been migrated here (a bare `--ci-*` now resolves to NOTHING → invisible chrome).
//
// 🔴 Two token traps this module deliberately avoids:
//   1. The `--civitai-color-gray-*` ramp is theme-INVARIANT (not redefined under
//      [data-theme='dark']) — never used for a theme-responsive surface here.
//   2. In LIGHT theme `body == surface == surface-2`, so a card gets NO fill
//      contrast — panels are separated by `border`, and a recess uses `elevate()`
//      (a token-derived tint that works in BOTH themes), never `surface-2`.

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
 * dark it lightens the panel) without touching the invariant gray ramp — which
 * is why we don't just use `surface-2` (identical to `body` in light mode).
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
