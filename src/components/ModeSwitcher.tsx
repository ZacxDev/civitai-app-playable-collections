// Mode switcher — a keyboard-operable segmented control (WAI-ARIA radiogroup).
//
// It reads the pack's CSS variables (`--civitai-color-*`, `--civitai-radius`,
// `--civitai-font`) so it matches the pack's look and themes automatically via
// the app's `data-theme` root.
//
// A11y (ship-blocker #4): implements the radiogroup roving-focus pattern —
// only the checked segment is tabbable (roving tabindex), and
// ArrowLeft/ArrowRight/Home/End move selection + focus across segments.
//
// 🔴 TRACK U: blocks-react 0.36 now ships its own `SegmentedControl`
// (`@civitai/blocks-react/ui`, role="tablist" + arrow roving). We keep this
// hand-rolled radiogroup for now because the app + tests rely on its
// `${testid}-${value}` ids, `data-selected`, glyph+title options, and the
// radio semantics; adopt the pack's version (migrating those hooks) once Track U
// settles the API. Not a blocker.
//
// Reused for BOTH the 3-way view-mode switch and the 3-way media-type filter, so
// the segmented-control shape is defined once.

import { useRef } from 'react';
import type { CSSProperties } from 'react';

import { nextIndex, rovingAction } from '../lib/roving.js';

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
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = rovingAction(e.key, 'horizontal');
    if (!action) return;
    e.preventDefault();
    const target = nextIndex(action, selectedIndex, options.length);
    const opt = options[target];
    if (opt) {
      onChange(opt.value);
      btnRefs.current[target]?.focus();
    }
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} data-testid={testid} style={trackStyle} onKeyDown={onKeyDown}>
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.title ?? opt.label}
            title={opt.title ?? opt.label}
            // Roving tabindex: only the checked segment is in the tab order.
            tabIndex={selected ? 0 : -1}
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
  borderRadius: 'var(--civitai-radius)',
  border: '1px solid var(--civitai-color-border)',
  background: 'var(--civitai-color-surface-2)',
  fontFamily: 'var(--civitai-font)',
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
    borderRadius: 'calc(var(--civitai-radius) - 2px)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    color: selected ? 'var(--civitai-color-primary-fg, #fff)' : 'var(--civitai-color-text)',
    background: selected ? 'var(--civitai-color-primary)' : 'transparent',
    transition: 'background 120ms ease',
  };
}
