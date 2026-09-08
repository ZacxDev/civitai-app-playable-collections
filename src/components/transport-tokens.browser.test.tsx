// 🔴 THE TRANSPORT CONTROLS TAKE EVERY COLOUR FROM A TOKEN, AND THIS PROVES IT BY
// READING COMPUTED STYLE — not by checking that a class name is present.
//
// Operator feedback, round 4: "the slideshow buttons are still unthemed". They
// were: `iconBtn` carried its own colour literals, which made it a SECOND COPY of
// the `stage` group in `../theme.js`. The two had already drifted — border
// `rgba(255,255,255,0.25)` here against `stage.chromeBtnBorder`'s
// `rgba(255,255,255,0.28)`. Nothing asserted on either, so nothing noticed.
//
// 🔴 THE CLAIM THIS FILE PINS IS DELIBERATELY NOT "THEY CHANGE WITH THE THEME".
// Over-media chrome is theme-INVARIANT by design (`../theme.js`'s `stage` header
// says so): these controls sit on ARBITRARY USER MEDIA, not on the page
// background, so a control tinted to a light theme would vanish on a bright
// image. Asserting that they DO vary would have pinned the wrong property and
// forced a real regression. What varies is the ACTIVE state, which uses the
// theme's `primary` pair so a pressed control picks up the brand.
//
// So the two-theme requirement is honoured by asserting BOTH halves across both
// themes: the over-media colours are identical, and the active pair is not.
//
// jsdom cannot settle any of this — it has no cascade layers and does not resolve
// `var()`, so `getComputedStyle` there returns the literal `var(--civitai-...)`
// string. See `browser-tier.browser.test.tsx`, which measures exactly that.

import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// 🔴 THE APP'S REAL TOKEN SOURCE, IMPORTED ON PURPOSE. Without it
// `--civitai-color-primary` is undefined in this document and every token
// reference computes to `rgba(0, 0, 0, 0)` — a transparent value that LOOKS like
// a resolved colour. The suite would then measure nothing while appearing to.
import '../skin.css';

import { iconBtn } from './styles.js';
import { palette, stage } from '../theme.js';

afterEach(cleanup);

/**
 * Render one icon control under an explicit theme and hand back its COMPUTED
 * style. `data-theme` is what `@civitai/theme` keys its token values off.
 */
function computedUnder(theme: 'light' | 'dark', active = false) {
  const c = palette();
  const { container } = render(
    <div data-pc-skin data-theme={theme}>
      <button type="button" style={iconBtn(c, active)} data-testid="probe">
        ▶
      </button>
    </div>,
  );
  const el = container.querySelector<HTMLElement>('[data-testid="probe"]')!;
  const s = getComputedStyle(el);
  return { color: s.color, background: s.backgroundColor, border: s.borderTopColor };
}

/** `rgba(0, 0, 0, 0.45)` and `rgba(0,0,0,0.45)` are the same colour to a browser. */
function normalise(v: string) {
  return v.replace(/\s+/g, '');
}

describe('transport icon controls resolve from tokens, not literals', () => {
  it('🔴 the RESTING control matches the stage tokens exactly — no second copy', () => {
    // The regression case. Re-introducing a literal here (or letting one drift
    // from `stage`) fails this, which is what the old code could not do.
    const probe = document.createElement('div');
    document.body.appendChild(probe);

    for (const [prop, expected] of [
      ['color', stage.chromeFg],
      ['background-color', stage.chromeBtnBg],
      ['border-top-color', stage.chromeBtnBorder],
    ] as const) {
      probe.style.setProperty(prop, expected);
    }
    const want = getComputedStyle(probe);
    const got = computedUnder('dark');

    expect(normalise(got.color)).toBe(normalise(want.color));
    expect(normalise(got.background)).toBe(normalise(want.backgroundColor));
    expect(normalise(got.border)).toBe(normalise(want.borderTopColor));

    probe.remove();
  });

  it('🔴 over-media chrome is IDENTICAL in light and dark — invariance is the property', () => {
    // Asserting sameness, not difference. These controls read against user media,
    // so a theme-varying resting state would be the defect, not the fix.
    const light = computedUnder('light');
    const dark = computedUnder('dark');
    expect(normalise(light.color)).toBe(normalise(dark.color));
    expect(normalise(light.background)).toBe(normalise(dark.background));
    expect(normalise(light.border)).toBe(normalise(dark.border));
  });

  it('the ACTIVE state DOES vary by theme — the control still carries the brand', () => {
    // The counterpart, and the reason the case above is not just "nothing is
    // themed". Without this, dropping every token for a fixed literal would pass.
    const light = computedUnder('light', true);
    const dark = computedUnder('dark', true);
    expect(normalise(light.background)).not.toBe(normalise(dark.background));
  });

  it('the resting and active states are visibly different in BOTH themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const resting = computedUnder(theme);
      const active = computedUnder(theme, true);
      expect(normalise(active.background)).not.toBe(normalise(resting.background));
    }
  });

  it('every colour resolves to a REAL colour — no unresolved var() reaches the browser', () => {
    // 🔴 The failure this catches is specific: a token reference that does not
    // resolve computes to the literal string `var(--civitai-...)` rather than
    // falling back to something visible, and the control renders with the UA
    // default. jsdom cannot see this at all, which is why it lives here.
    for (const theme of ['light', 'dark'] as const) {
      for (const active of [false, true]) {
        const got = computedUnder(theme, active);
        for (const v of [got.color, got.background, got.border]) {
          expect(v).not.toContain('var(');
          expect(v).toMatch(/^rgba?\(/);
          // 🔴 THE ALPHA CHECK IS THE POINT, AND WITHOUT IT THIS GUARD IS
          // WALKABLE BY THE EXACT CASE IT EXISTS TO CATCH. An UNRESOLVED custom
          // property computes to `rgba(0, 0, 0, 0)` — fully transparent, but it
          // contains no `var(` and it matches `/^rgba?\(/`, so both assertions
          // above pass while the control renders invisible. Measured: this test
          // went green against a genuinely broken active state before this line
          // existed.
          expect(normalise(v)).not.toBe('rgba(0,0,0,0)');
        }
      }
    }
  });
});
