// Mode switcher — a SegmentedControl / Tabs shape.
//
// 🔴 COMPONENT-PACK GAP: the pack's `<SegmentedControl>` is a `role="tablist"`
// with no per-segment glyphs or testids and no `role="radiogroup"` filter shape.
// This app needs a 3-way switch WITH glyphs (🎞/↔/▦) + per-segment testids the
// tests assert, reused for BOTH the view-mode switch and the media-type filter —
// so it stays a hand-styled control. It is tokenized to the design system: every
// value resolves to a `--civitai-*` token (via ../theme) so it matches the pack's
// look and flips with the app's `data-theme` root. The track uses `elevate()`
// (NOT surface-2, which equals body in light — the invisible-tile trap).

import type { CSSProperties } from 'react';

import { elevate, radius, token } from '../theme.js';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  /** Short glyph shown before the label (optional). */
  glyph?: string;
  /** Accessible label when the visible label is a glyph only. */
  title?: string;
}

export interface SegmentedControlProps<V extends string> {
  value: V;
  options: ReadonlyArray<SegmentOption<V>>;
  onChange: (value: V) => void;
  ariaLabel: string;
  /** data-testid prefix; each segment gets `${testid}-${value}`. */
  testid: string;
  size?: 'sm' | 'md';
}

export function SegmentedControl<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  testid,
  size = 'md',
}: SegmentedControlProps<V>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} data-testid={testid} style={trackStyle}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.title ?? opt.label}
            title={opt.title ?? opt.label}
            onClick={() => onChange(opt.value)}
            data-testid={`${testid}-${opt.value}`}
            data-selected={selected ? 'true' : 'false'}
            style={segStyle(selected, size)}
          >
            {opt.glyph && <span aria-hidden="true">{opt.glyph}</span>}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const VIEW_MODE_OPTIONS = [
  { value: 'classic', label: 'Slideshow', glyph: '🎞', title: 'Slideshow (one at a time)' },
  { value: 'continuous-horizontal', label: 'Ticker', glyph: '↔', title: 'Continuous horizontal ticker' },
  { value: 'continuous-vertical', label: 'Wall', glyph: '▦', title: 'Continuous vertical wall' },
] as const;

/** The view-mode segmented control, pre-wired with the three modes. */
export function ModeSwitcher({
  value,
  onChange,
}: {
  value: 'classic' | 'continuous-horizontal' | 'continuous-vertical';
  onChange: (v: 'classic' | 'continuous-horizontal' | 'continuous-vertical') => void;
}) {
  return (
    <SegmentedControl
      value={value}
      options={VIEW_MODE_OPTIONS}
      onChange={onChange}
      ariaLabel="View mode"
      testid="mode-switcher"
    />
  );
}

// ---- styles (design-system-token-driven) ----
const trackStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 2,
  padding: 3,
  borderRadius: radius.md,
  border: `1px solid ${token.border}`,
  // elevate() (a token-derived tint), NOT surface-2 — surface-2 == body in light,
  // which would make the track an invisible white-on-white recess.
  background: elevate(6),
  fontFamily: token.font,
};

function segStyle(selected: boolean, size: 'sm' | 'md'): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: size === 'sm' ? '3px 8px' : '5px 12px',
    fontSize: size === 'sm' ? 12 : 13,
    fontWeight: 600,
    lineHeight: 1.2,
    border: 'none',
    borderRadius: radius.sm,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    color: selected ? token.primaryFg : token.text,
    background: selected ? token.primary : 'transparent',
    transition: 'background 120ms ease',
  };
}
