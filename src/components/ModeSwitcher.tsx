// Mode switcher — a SegmentedControl / Tabs shape.
//
// 🔴 COMPONENT-PACK GAP (rule #112): `@civitai/blocks-react/ui` ships no
// SegmentedControl / Tabs / ToggleGroup primitive (only Button). So this is
// hand-styled to the pack idiom — it reads the pack's CSS variables
// (`--ci-color-*`, `--ci-radius`, `--ci-font`) so it matches the pack's look and
// themes automatically via the app's `data-theme` root. Reported as a pack gap.
//
// Reused for BOTH the 3-way view-mode switch and the 3-way media-type filter, so
// the segmented-control shape is defined once.

import type { CSSProperties } from 'react';

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

// ---- styles (pack-token-driven) ----
const trackStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 2,
  padding: 3,
  borderRadius: 'var(--ci-radius)',
  border: '1px solid var(--ci-color-border)',
  background: 'var(--ci-color-surface-2)',
  fontFamily: 'var(--ci-font)',
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
    borderRadius: 'calc(var(--ci-radius) - 2px)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    color: selected ? 'var(--ci-color-primary-fg)' : 'var(--ci-color-text)',
    background: selected ? 'var(--ci-color-primary)' : 'transparent',
    transition: 'background 120ms ease',
  };
}
