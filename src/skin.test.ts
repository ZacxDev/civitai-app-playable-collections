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

/**
 * What a LIGHT root actually resolves to.
 *
 * 🔴 The base selector is `[data-pc-skin][data-theme]`, which a light root ALSO
 * matches — so light does not start from nothing, it starts from the base block
 * and overrides. Anything light does not redefine (the invariant gray ramp) it
 * inherits. Reading the raw light block as if it were the whole light palette
 * models a cascade the browser does not have, and a token would look "missing"
 * in light when the page renders it correctly.
 *
 * The RAW blocks are still what the parity checks read — the distinction between
 * "defined here" and "resolves here" is exactly what those assert.
 */
const THEMES: Array<[string, Record<string, string>]> = [
  ['dark', DARK],
  ['light', { ...DARK, ...LIGHT }],
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
  //
  // The ONE legitimate exception is the ramp the pack consumes: gray-1/2/5 are
  // invariant BY DESIGN (upstream's own semantics — a "dark chip" stays dark),
  // and a light root also matches the base selector, so light inherits them
  // rather than repeating them. They are allowlisted BY NAME, so forgetting a
  // theme-varying token still fails — the allowlist is the claim, not a hole.
  const INVARIANT_BY_DESIGN = ['--civitai-color-gray-1', '--civitai-color-gray-2', '--civitai-color-gray-5'];

  it('light redefines every theme-varying token the base block defines', () => {
    const expected = Object.keys(DARK)
      .filter((k) => !INVARIANT_BY_DESIGN.includes(k))
      .sort();
    expect(Object.keys(LIGHT).sort()).toEqual(expected);
  });

  it('the allowlist is exactly the ramp entries the pack pairs with no varying fg', () => {
    // Guards the allowlist itself: widening it is how this test stops biting.
    // gray-9 is deliberately NOT here — it pairs with primary-fg, so it must
    // co-vary; see the pack-pairings block below.
    expect(INVARIANT_BY_DESIGN.every((k) => k in DARK && !(k in LIGHT))).toBe(true);
    expect(INVARIANT_BY_DESIGN).not.toContain('--civitai-color-gray-9');
    expect('--civitai-color-gray-9' in LIGHT).toBe(true);
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

// 🔴 THIS BLOCK USED TO SCAN `src/**` ONLY, AND THAT WAS THE BUG. Its own
// docstring named the failure mode — a token the app USES but the skin does not
// DEFINE falls back to the platform's blue-grey inside a rose UI — and the whole
// stated reason for skinning TOKENS rather than components is that it "skins the
// app and the pack together". But the pack is not in `src/`, so the guard could
// not see the pack's own references, and the pack reaches past the semantic
// tokens into the theme-INVARIANT `--civitai-color-gray-*` ramp. Result, measured
// in a browser: a Slider track painted #e9ecef on a rose light surface. The guard
// read as coverage while providing half of it.
//
// It now scans the app AND both packages' shipped CSS.
const PACK_CSS = [
  '../node_modules/@civitai/components/dist/components.css',
  '../node_modules/@civitai/blocks-react/dist/ui/styles.js',
];

describe('skin coverage of every token that reaches this app', () => {
  const appUsed = new Set<string>();
  for (const f of sourceFiles(SRC)) {
    if (f.endsWith('skin.css')) continue; // the definitions, not a consumption
    for (const m of decomment(readFileSync(f, 'utf8')).matchAll(/var\(\s*(--civitai-color-[\w-]+)/g)) {
      appUsed.add(m[1]);
    }
  }

  const packUsed = new Set<string>();
  for (const rel of PACK_CSS) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    for (const m of src.matchAll(/var\(\s*(--civitai-color-[\w-]+)/g)) packUsed.add(m[1]);
  }

  it('found tokens in BOTH populations (positive control — a zero passes everything)', () => {
    expect(appUsed.size).toBeGreaterThanOrEqual(6);
    // If this goes to zero the pack moved its stylesheet and the scan is reading
    // nothing, which would look exactly like "the pack references no tokens".
    expect(packUsed.size).toBeGreaterThanOrEqual(6);
  });

  it('defines every --civitai-color-* the APP references', () => {
    expect([...appUsed].filter((t) => !(t in DARK)).sort()).toEqual([]);
  });

  it('defines every --civitai-color-* the PACK references', () => {
    // The pack renders inside our root, so it resolves against our tokens. Any
    // name we do not define silently keeps the platform value.
    expect([...packUsed].filter((t) => !(t in DARK)).sort()).toEqual([]);
  });
});

// The pack pairs one INVARIANT ramp token with a theme-VARYING foreground, and
// that combination is what a skin can break without touching either file.
describe('pack pairings the skin has to keep legible', () => {
  it.each(THEMES)('%s: the tooltip bubble carries its own text', (_name, p) => {
    // @civitai/components: [data-civitai-ui-tooltip-bubble] is
    // `background: gray-9; color: primary-fg`. Upstream that is always safe
    // because primary-fg is #fefefe in both themes. Here it is NOT: our dark
    // primary-fg is a near-black (it has to be, to carry 6.3:1 on a light rose
    // primary), and near-black on the platform's dark gray-9 measures 1.20:1.
    // No Tooltip renders in this app today — this pins it anyway, because
    // "we do not use that component yet" is not a property anyone re-checks.
    expect(contrast(c(p, 'primary-fg'), c(p, 'gray-9'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: a pack Slider track is visible against the surface under it', (_name, p) => {
    // light: gray-2; dark: the pack's own [data-theme='dark'] rule swaps in
    // surface-2. Assert whichever this theme actually resolves to.
    const track = _name === 'light' ? c(p, 'gray-2') : c(p, 'surface-2');
    expect(contrast(track, c(p, 'surface'))).toBeGreaterThanOrEqual(1.06);
    // ...and the filled portion (accent-color: primary) must read on that track.
    expect(contrast(c(p, 'primary'), track)).toBeGreaterThanOrEqual(1.5);
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
  // 🔴 REWRITTEN AFTER AN AUDIT SHOWED THE FIRST VERSION WAS HALF-BLIND. It
  // removed the layer block with `.replace(/@layer\s+app\s*\{[\s\S]*\n\}/, '')`,
  // and `[\s\S]*` is GREEDY: it backtracks to the LAST `\n}` in the file, so the
  // replace ate everything from `@layer app {` to EOF. An unlayered rule appended
  // AFTER the layer — the direction a maintainer actually edits a file — was
  // deleted along with it and never checked. Measured: appending
  // `.pc-evil-unlayered { border: 0 }` left this guard green at 30/30, while the
  // same rule placed BEFORE the layer went red. The docstring claimed the
  // coverage; the body provided half of it.
  //
  // Brace-matching instead, which does not care where the rule sits.
  it('index.css IS layered, and EVERY style rule is inside the layer', () => {
    const css = decomment(INDEX_CSS);
    const open = css.search(/@layer\s+app\s*\{/);
    expect(open).toBeGreaterThan(-1);

    // Walk to the layer's own matching close brace.
    let depth = 0;
    let close = -1;
    for (let i = css.indexOf('{', open); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close).toBeGreaterThan(open); // the layer block is balanced

    let outside = css.slice(0, open) + css.slice(close + 1);
    // Drop whole at-rule blocks first. @keyframes is not a style rule and takes
    // no part in the cascade, but its stops (`0% {`, `50% {`) are shaped exactly
    // like selectors, so scanning without this reports them as stray rules.
    outside = outside.replace(/@[\w-]+[^{;]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    const strayRules = outside.match(/(^|\n)\s*[^@\s}][^{}]*\{/g);
    expect(strayRules ?? []).toEqual([]);
  });

  // The control the first version silently lacked: prove the walk can SEE a rule
  // on the far side of the layer, so a future green is worth something.
  it('...and that check can actually see a rule appended AFTER the layer', () => {
    const css = decomment(INDEX_CSS);
    const open = css.search(/@layer\s+app\s*\{/);
    let depth = 0;
    let close = -1;
    for (let i = css.indexOf('{', open); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    const mutated = `${css.slice(0, open)}${css.slice(open, close + 1)}\n.pc-appended-unlayered { border: 0; }\n${css.slice(close + 1)}`;
    const outside = mutated.slice(0, open) + mutated.slice(mutated.indexOf('}', close) + 1);
    expect(outside).toContain('.pc-appended-unlayered');
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

  // (4) 🔴 THE ROUTE THIS PR ORIGINALLY CALLED "the two ways" AND MISSED. An
  // audit commented out `import './skin.css'` in main.tsx and the FULL suite
  // stayed green at 436/436, both tiers — the app shipping with every surface
  // reverted to platform blue-grey, stylesheet loaded nowhere, no console error.
  // Every other guard here reads the CSS off disk, and jsdom applies no CSS at
  // all, so the one line that makes the skin reach a browser was unpinned.
  //
  // 🔴 AND IT MUST IGNORE COMMENTED-OUT CODE. The first version of this guard
  // searched the file text for `'./skin.css'`, which is a claim about a WORD, not
  // about a code path — the mutant that disables an import is `// import …`, and
  // the word survives it. It passed the mutation it was written for. `decomment`
  // only strips /* */ blocks, so line comments have to go too.
  it('main.tsx actually IMPORTS the skin, after the tokens it overrides', () => {
    const main = decomment(read('./main.tsx'))
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const theme = main.indexOf("'@civitai/theme/styles.css'");
    const skin = main.indexOf("'./skin.css'");
    expect(theme).toBeGreaterThan(-1); // positive control: we are reading main.tsx
    expect(skin).toBeGreaterThan(-1);
    // Order is not what makes the skin win — specificity is — but importing the
    // overrides before the thing they override is the readable arrangement, and
    // an accidental reorder is worth a look rather than a silent pass.
    expect(skin).toBeGreaterThan(theme);
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
