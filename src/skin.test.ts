// The dual-theme contract for `brandDepth: skin`.
//
// 🔴 WHY THIS FILE EXISTS AT ALL. Under `accent` the platform owned light/dark
// correctness and there was nothing here to get wrong. src/skin.css takes that
// debt on, and the debt is INVISIBLE — a skin can be beautiful in the theme its
// author had open and unreadable in the other, and no runtime error is produced
// either way. The taste rubric therefore makes a both-themes assertion for every
// surface/border/text pair mandatory under `skin`, and this is it.
//
// The oracle is WCAG contrast computed from the shipped values, not a snapshot of
// them: it can say a palette is WRONG, which a golden file cannot. Restyling is
// free until it makes something unreadable, at which point the pair that broke is
// named in the failure.
//
// 🔴 It also pins the two INERTNESS mechanisms, which are the ways this skin can
// be switched off while looking present — see the structural describe block. Both
// were live risks in the design, not hypotheticals: one is the cascade-layer trap
// the design-system skill has recorded three times.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SKIN_CSS = read('./skin.css');
const INDEX_CSS = read('./index.css');
const INDEX_HTML = read('../index.html');

/** Strip CSS comments. Every structural lookup below goes through this — a rule
 *  and a sentence describing a rule are not the same claim (bootTokens.test.ts
 *  learned that the expensive way). */
const decomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------------------
// colour maths (sRGB relative luminance, WCAG 2.x)
// ---------------------------------------------------------------------------

function parseColor(v: string): [number, number, number] {
  const s = v.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
  throw new Error(`unparseable colour: ${v}`);
}

function luminance(v: string): number {
  const chan = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseColor(v);
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG contrast ratio, 1..21. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// A control on the maths itself: pure black on pure white is exactly 21:1, and
// any colour against itself is exactly 1:1. Without this, a broken parser would
// make every assertion below pass or fail for reasons that have nothing to do
// with the palette.
describe('the contrast oracle', () => {
  it('is calibrated against known ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#fa6478', '#fa6478')).toBeCloseTo(1, 5);
    // mid-grey on white is a published value (~5.32:1 for #767676)
    expect(contrast('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.6);
  });

  it('rejects a value it cannot parse instead of scoring it', () => {
    expect(() => contrast('color-mix(in srgb, red, blue)', '#fff')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// the palettes, read out of the shipped stylesheet
// ---------------------------------------------------------------------------

/** Every `--civitai-*: value;` declaration inside the block whose selector text
 *  contains `needle`. Throws if that block is missing — an absent theme must not
 *  read as "a theme with nothing wrong in it". */
function skinBlock(needle: string): Record<string, string> {
  const css = decomment(SKIN_CSS);
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selector = m[1].trim();
    if (!selector.includes(needle)) continue;
    const out: Record<string, string> = {};
    for (const d of m[2].matchAll(/(--civitai-[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    return out;
  }
  throw new Error(`no skin block whose selector contains ${needle}`);
}

/** Dark is the base block; it is keyed on bare `[data-theme]` so an unrecognised
 *  host theme lands on dark, matching bootThemeGuess(). Light is the override. */
const DARK = skinBlock('[data-pc-skin][data-theme]');
const LIGHT = skinBlock("[data-pc-skin][data-theme='light']");
const THEMES: Array<[string, Record<string, string>]> = [
  ['dark', DARK],
  ['light', LIGHT],
];

const c = (p: Record<string, string>, name: string): string => {
  const v = p[`--civitai-color-${name}`];
  if (!v) throw new Error(`skin does not define --civitai-color-${name}`);
  return v;
};

describe('skin palette — both themes', () => {
  it('defines a dark and a light block, and they are not the same palette', () => {
    expect(Object.keys(DARK).length).toBeGreaterThan(10);
    expect(c(DARK, 'body')).not.toBe(c(LIGHT, 'body'));
    expect(c(DARK, 'text')).not.toBe(c(LIGHT, 'text'));
  });

  // 🔴 The failure this catches is the one that produced the trap the skin
  // replaces: upstream's dark block redefines 14 of 32 tokens, so the gray ramp
  // is theme-invariant and silently wrong in one theme. A key present in one of
  // our blocks and absent from the other has exactly that shape.
  it('both themes define the SAME key set', () => {
    expect(Object.keys(LIGHT).sort()).toEqual(Object.keys(DARK).sort());
  });

  it.each(THEMES)('%s: body text is readable on every surface it lands on', (_name, p) => {
    for (const surface of ['body', 'surface', 'surface-2']) {
      expect(contrast(c(p, 'text'), c(p, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Dimmed text is 12–13px throughout this app (mutedText / metaText in theme.ts,
  // the sort hint, every card's meta line), so it is NORMAL text under WCAG and
  // gets the 4.5 floor, not the 3.0 large-text one.
  it.each(THEMES)('%s: dimmed text clears the NORMAL-text floor, not the large one', (_name, p) => {
    for (const surface of ['body', 'surface', 'surface-2']) {
      expect(contrast(c(p, 'text-dimmed'), c(p, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('%s: a filled primary button carries its own label', (_name, p) => {
    expect(contrast(c(p, 'primary-fg'), c(p, 'primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c(p, 'primary-fg'), c(p, 'primary-hover'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: primary reads as an accent against the app surfaces', (_name, p) => {
    for (const surface of ['body', 'surface']) {
      expect(contrast(c(p, 'primary'), c(p, surface))).toBeGreaterThanOrEqual(3.0);
    }
  });

  it.each(THEMES)('%s: semantic text is readable on a card', (_name, p) => {
    for (const sem of ['error', 'success', 'warning']) {
      expect(contrast(c(p, sem), c(p, 'surface'))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('%s: a border is visible against both planes it separates', (_name, p) => {
    expect(contrast(c(p, 'border'), c(p, 'surface'))).toBeGreaterThanOrEqual(1.35);
    expect(contrast(c(p, 'border'), c(p, 'body'))).toBeGreaterThanOrEqual(1.35);
  });

  // 🔴 THE TRAP THE SKIN EXISTS TO FIX, pinned so it cannot come back. Upstream
  // light had body == surface == surface-2 (all #fefefe), so a card had no fill
  // contrast at all and panels could only be told apart by their border. A skin
  // is free to choose its own values — it is NOT free to re-flatten these three.
  it.each(THEMES)('%s: the three planes are actually three planes', (_name, p) => {
    expect(contrast(c(p, 'surface'), c(p, 'body'))).toBeGreaterThanOrEqual(1.06);
    expect(contrast(c(p, 'surface-2'), c(p, 'surface'))).toBeGreaterThanOrEqual(1.06);
    expect(c(p, 'surface')).not.toBe(c(p, 'body'));
    expect(c(p, 'surface-2')).not.toBe(c(p, 'surface'));
  });

  it('keeps the brand plate itself as the dark primary', () => {
    // brand/README.md: the plate is #FA6478. Dark can carry it unchanged; light
    // cannot (white on it is 2.35:1), which is why light drives the same hue down
    // in lightness rather than introducing a second hue.
    expect(c(DARK, 'primary').toLowerCase()).toBe('#fa6478');
    expect(contrast('#ffffff', '#fa6478')).toBeLessThan(4.5); // the reason light differs
  });
});

// ---------------------------------------------------------------------------
// coverage: a token the app USES but the skin does not DEFINE falls back to the
// platform's blue-grey inside a rose UI, with no error.
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (/\.(ts|tsx|css)$/.test(e) && !/\.test\.tsx?$/.test(e)) acc.push(p);
  }
  return acc;
}

describe('skin coverage of the tokens this app actually consumes', () => {
  const used = new Set<string>();
  for (const f of sourceFiles(SRC)) {
    if (f.endsWith('skin.css')) continue; // the definitions, not a consumption
    for (const m of decomment(readFileSync(f, 'utf8')).matchAll(/var\(\s*(--civitai-color-[\w-]+)/g)) {
      used.add(m[1]);
    }
  }

  it('found colour tokens to check (positive control — a zero here proves nothing)', () => {
    expect(used.size).toBeGreaterThanOrEqual(6);
  });

  it('defines every --civitai-color-* the app references, in BOTH themes', () => {
    const missing = [...used].filter((t) => !(t in DARK) || !(t in LIGHT)).sort();
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the two ways this skin can be silently switched off
// ---------------------------------------------------------------------------

describe('structural — the skin cannot be made inert without failing here', () => {
  // (1) CASCADE LAYERS. Unlayered declarations beat layered ones outright. The
  // token overrides must therefore stay unlayered to beat @civitai/theme, which
  // is itself unlayered. Wrapping this file in `@layer app` "for consistency"
  // with index.css would turn the entire skin off and produce no error anywhere.
  it('skin.css is UNLAYERED', () => {
    expect(decomment(SKIN_CSS)).not.toMatch(/@layer/);
  });

  // ...and the mirror image: index.css's reset MUST be layered, or it beats
  // @civitai/components (which ships inside `@layer civitai.components` and is
  // injected here at runtime by injectBlocksStyles()) and strips the pack's
  // borders and backgrounds. That is the design system's most-repeated gotcha.
  it('index.css IS layered, and its style rules are inside the layer', () => {
    const css = decomment(INDEX_CSS);
    expect(css).toMatch(/@layer\s+app\s*\{/);
    // Everything after the layer's closing brace must be at-rules only — today
    // that is the @keyframes block, which takes no part in the cascade.
    const tail = css.slice(css.lastIndexOf('}') === -1 ? 0 : 0);
    const outsideRules = tail
      .replace(/@layer\s+app\s*\{[\s\S]*\n\}/, '') // the layer block itself
      .match(/(^|\n)\s*[^@\s][^{}]*\{/g);
    expect(outsideRules ?? []).toEqual([]);
  });

  // Layer RANK is fixed by first encounter, and @civitai/components arrives at
  // RUNTIME — so if the pack injected before the app's order statement was seen,
  // `app` would outrank `civitai.components` and the reset would win after all.
  // An inline <style> in <head> is parsed before any script, which is the only
  // position that cannot lose that race.
  it('index.html declares the layer order before any script runs', () => {
    const decl = /@layer\s+app\s*,\s*civitai\.components\s*;/.exec(INDEX_HTML);
    expect(decl).not.toBeNull();
    const firstScript = INDEX_HTML.indexOf('<script');
    expect(firstScript).toBeGreaterThan(-1); // positive control: there IS a script
    expect(decl!.index).toBeLessThan(firstScript);
    // ...and inside a real <style>, not a comment describing one.
    const style = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML);
    expect(style).not.toBeNull();
    expect(decomment(style![1])).toMatch(/@layer\s+app\s*,\s*civitai\.components\s*;/);
  });

  it('orders app BELOW civitai.components, not above', () => {
    const m = /@layer\s+([\w.]+)\s*,\s*([\w.]+)\s*;/.exec(decomment(INDEX_HTML));
    expect(m).not.toBeNull();
    expect(m![1]).toBe('app'); // earlier = lower rank = loses to the pack
    expect(m![2]).toBe('civitai.components');
  });

  // (2) SPECIFICITY. @civitai/theme's blocks are `:root` / `[data-theme='…']`,
  // all (0,1,0), and the pack's sheet is injected AFTER the bundle — so a bare
  // `[data-pc-skin]` would tie and lose on source order. Every skin selector must
  // be compound.
  it('every skin selector is compound enough to beat @civitai/theme', () => {
    const css = decomment(SKIN_CSS);
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim());
    expect(selectors.length).toBeGreaterThan(0); // positive control
    for (const s of selectors) {
      expect(s).toContain('[data-pc-skin]');
      expect(s).toMatch(/\[data-theme/);
    }
  });

  // (3) THE SWITCH ITSELF. Every one of those selectors needs `data-pc-skin` on
  // the committed root. src/skinRoot.test.tsx asserts the rendered DOM (the half
  // that would actually have caught the bug); this is the LEDGER half, covering
  // the roots the DOM tier cannot drive into. It lives here rather than beside
  // that file because reading source needs the `node` project — in `dom`,
  // `import.meta.url` is an http: URL and `fileURLToPath` throws.
  describe('ledger — no App.tsx root can exist without the skin switch', () => {
    const APP_TSX = read('./App.tsx');
    const stamped = [...APP_TSX.matchAll(/<div ref=\{rootRef\} data-pc-skin data-theme=\{dataTheme\}/g)];
    const allRoots = [...APP_TSX.matchAll(/data-theme=\{dataTheme\}/g)];

    it('found roots at all (positive control — a zero passes every check below)', () => {
      expect(allRoots.length).toBeGreaterThan(0);
    });

    it('every data-theme root is also a data-pc-skin root', () => {
      expect(stamped.length).toBe(allRoots.length);
    });

    // 🔴 Pinned COUNT, not just parity. Parity alone still passes if a root is
    // deleted, and passes if a fourth is added in a shape the first regex does
    // not recognise (a fragment, a different attribute order) — both of which
    // ship an unskinned surface. Changing this number is meant to be a decision:
    // drive the new root and see the skin on it before you edit the literal.
    it('there are exactly three roots (boot / player / browse)', () => {
      expect(allRoots.length).toBe(3);
    });
  });

  it('states every value as a literal colour, never a var() back into the tokens', () => {
    for (const [, p] of THEMES) {
      for (const [k, v] of Object.entries(p)) {
        if (!k.startsWith('--civitai-color-')) continue;
        expect(v).not.toMatch(/var\(/); // would be self-referential
        expect(() => parseColor(v)).not.toThrow();
      }
    }
  });
});
