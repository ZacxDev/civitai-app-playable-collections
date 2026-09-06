// The header mark must stay the mark in brand/icon.svg.
//
// brand/README.md names the vector as the source of truth for the icon, and the
// store icon is DERIVED from it by the lighting + normalisation pipeline. So the
// same three colours and the same geometry appear in two places that no build
// step connects: the authored SVG, and the inline copy this app renders in its
// own header. Nothing else would notice them diverging — you would have to open
// the store listing and the running app side by side, in the right theme, and
// spot a shade. This is that check, done mechanically.
//
// It deliberately compares against the FILE rather than a literal transcribed
// into this test: a literal here would only ever prove the component matches
// itself.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BRAND_DISC, BRAND_GLYPH, BRAND_PLATE } from './components/BrandMark.js';

const ICON_SVG = readFileSync(new URL('../brand/icon.svg', import.meta.url), 'utf8');
const MARK_TSX = readFileSync(new URL('./components/BrandMark.tsx', import.meta.url), 'utf8');

/** Every hex literal in a file, upper-cased, in document order. */
const hexes = (s: string) => [...s.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase());

describe('the header mark tracks brand/icon.svg', () => {
  it('read a mark to check (positive control — a zero would pass everything below)', () => {
    expect(hexes(ICON_SVG).length).toBe(3);
  });

  it('uses the authored plate, disc and glyph colours, in that order', () => {
    expect([BRAND_PLATE, BRAND_DISC, BRAND_GLYPH].map((h) => h.toUpperCase())).toEqual(hexes(ICON_SVG));
  });

  it('the plate is the brand hue the kit documents', () => {
    // brand/README.md's table: Plate #FA6478. Stated independently of icon.svg so
    // an edit to BOTH files still has to disagree with the written brand kit.
    expect(BRAND_PLATE.toUpperCase()).toBe('#FA6478');
    expect(readFileSync(new URL('../brand/README.md', import.meta.url), 'utf8')).toContain('#FA6478');
  });

  it('keeps the authored geometry — same viewBox, disc and triangle', () => {
    expect(ICON_SVG).toContain('viewBox="0 0 1024 1024"');
    expect(MARK_TSX).toContain('viewBox="0 0 1024 1024"');
    // r=340 at 512,512, and a right-pointing triangle 442→682. A mark whose
    // triangle points the wrong way is the exact failure brand/README.md records
    // the generator making, twice.
    expect(ICON_SVG).toMatch(/r="340(\.0+)?"/);
    expect(MARK_TSX).toContain('r="340"');
    expect(ICON_SVG).toMatch(/points="442\.00,382\.00 442\.00,642\.00 682\.00,512\.00"/);
    expect(MARK_TSX).toContain('points="442,382 442,642 682,512"');
  });

  it('does NOT theme the mark — an identity is the same in both themes', () => {
    // The counterpart of skin.css: everything else flips, this must not. A
    // `var(--civitai-color-…)` fill here would make the logo change colour with
    // the host theme and stop matching the store icon in one of them.
    const fills = [...MARK_TSX.matchAll(/fill=\{?([^}\s/>]+)\}?/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(0); // positive control
    for (const f of fills) expect(f).not.toMatch(/--civitai-color/);
  });
});
