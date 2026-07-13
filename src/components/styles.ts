// Reusable inline-style builders keyed off the resolved Palette. Shared by the
// grid, player, and modals so button/card/input styling stays consistent.

import type { CSSProperties } from 'react';

import type { Palette } from '../theme.js';

export function primaryBtn(c: Palette, disabled = false): CSSProperties {
  return {
    padding: '10px 16px',
    border: 'none',
    borderRadius: 8,
    background: disabled ? c.border : c.accent,
    color: disabled ? c.muted : c.accentFg,
    fontWeight: 700,
    fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
  };
}

export function ghostBtn(c: Palette, disabled = false): CSSProperties {
  return {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid ' + c.border,
    background: 'transparent',
    color: disabled ? c.muted : c.fg,
    fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
  };
}

export function dangerText(c: Palette): CSSProperties {
  return { color: c.danger };
}

export function inputStyle(c: Palette): CSSProperties {
  return {
    padding: 10,
    borderRadius: 8,
    border: '1px solid ' + c.border,
    background: c.inputBg,
    color: c.fg,
    fontSize: 14,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
    width: '100%',
  };
}

export function cardStyle(c: Palette): CSSProperties {
  return {
    background: c.card,
    border: '1px solid ' + c.border,
    borderRadius: 10,
    padding: 12,
    display: 'grid',
    gap: 8,
  };
}

export function chipStyle(c: Palette, active: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 999,
    border: '1px solid ' + (active ? c.chipActiveBg : c.border),
    background: active ? c.chipActiveBg : c.chipBg,
    color: active ? c.accentFg : c.fg,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

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
