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
// 🔴 It also pins the THREE INERTNESS mechanisms — the ways this skin can be
// switched off while looking present. See the structural describe block. All three
// were live risks, not hypotheticals: one is the cascade-layer trap the
// design-system skill has recorded three times, and the third (main.tsx simply not
// importing the skin) was found by an audit AFTER this file claimed there were two.
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

  // 🔴 PINS THE SIZE THE LEDGER QUOTES. taste.json said "28 token values", then
  // "32"; neither was ever right, and both went unnoticed for the same reason the
  // 2.35 figure did — no assertion read them. This is the whole 2.35 lesson
  // applied to a second number rather than re-learned on it. A palette change is
  // free; changing the SHAPE of the palette has to move a number the ledger quotes.
  it('the palette size the ledger quotes is derived, not typed', () => {
    const declarations = [...decomment(SKIN_CSS).matchAll(/(--civitai-[\w-]+)\s*:/g)].map((m) => m[1]);
    const colour = declarations.filter((d) => d.startsWith('--civitai-color-'));
    expect(declarations).toHaveLength(35); // 33 colour + --civitai-radius in both blocks
    expect(new Set(declarations).size).toBe(19);
    expect(colour).toHaveLength(33);
    expect(new Set(colour).size).toBe(18);
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

  // 🔴 PINS THE SET, NOT ITS SHAPE. The previous version asserted only that each
  // entry was in DARK, absent from LIGHT, and that gray-9 was not listed — which
  // is a property ANY token can satisfy. Measured: appending
  // '--civitai-color-info' to the array and deleting it from the light block left
  // the suite 444/444 green, while light silently inherited dark's #fa6478 and
  // `info` fell to 2.93:1 on white against the correct 5.23:1. `info` carries no
  // contrast assertion, so nothing else caught it. The comment claimed "widening
  // it is how this test stops biting" — and widening it was free.
  it('the allowlist is EXACTLY the three invariant ramp entries', () => {
    expect([...INVARIANT_BY_DESIGN].sort()).toEqual([
      '--civitai-color-gray-1',
      '--civitai-color-gray-2',
      '--civitai-color-gray-5',
    ]);
    // ...and each behaves the way "invariant" means: defined once in the base
    // block, inherited by light rather than redeclared.
    for (const k of INVARIANT_BY_DESIGN) {
      expect(k in DARK).toBe(true);
      expect(k in LIGHT).toBe(false);
    }
    // gray-9 is the deliberate non-member: it pairs with the theme-varying
    // primary-fg, so it must co-vary. See the pack-pairings block below.
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
    // cannot, which is why light drives the same hue down in lightness rather
    // than introducing a second hue.
    expect(c(DARK, 'primary').toLowerCase()).toBe('#fa6478');
    expect(contrast('#ffffff', '#fa6478')).toBeLessThan(4.5); // the reason light differs
  });

  // 🔴 PINS THE NUMBER THE PROSE QUOTES. The figure for white-on-plate was written
  // as 2.35:1 in five places — a comment, skin.css, taste.json, a commit message
  // and the PR body — and it was simply WRONG; the value is 2.93:1, and 2.35
  // corresponds to nothing in this palette. The CONCLUSION was unaffected (both
  // are under 4.5, so light still cannot use the plate), which is exactly why
  // nobody noticed: no assertion read it, so it was unpinned by construction and
  // drifted into four more documents. Asserting it here makes the next quote
  // checkable instead of copied.
  it('the white-on-plate figure the docs quote is the real one', () => {
    expect(Number(contrast('#ffffff', '#fa6478').toFixed(2))).toBe(2.93);
    // and the two that justify the split, quoted in the same breath
    expect(Number(contrast(c(DARK, 'primary-fg'), c(DARK, 'primary')).toFixed(2))).toBe(6.32);
    expect(Number(contrast(c(LIGHT, 'primary-fg'), c(LIGHT, 'primary')).toFixed(2))).toBe(5.23);
  });
});

// ---------------------------------------------------------------------------
// coverage: a token the app USES but the skin does not DEFINE falls back to the
// platform's blue-grey inside a rose UI, with no error.
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, acc: string[] = [], match = /\.(ts|tsx|css)$/): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, acc, match);
    else if (match.test(e) && !/\.test\.tsx?$/.test(e)) acc.push(p);
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
// It now scans the app AND both packages — 🔴 EVERY file in them, not a list of
// two. The previous version named `components/dist/components.css` and
// `blocks-react/dist/ui/styles.js` while the comment and the ledger both claimed
// it "scans BOTH packages and fails if the set grows". Nine files across the two
// packages reference tokens; the two named ones happen to contribute the whole
// 16-token union today, so there was no live gap — but a reference added to, say,
// `blocks-react/dist/ui/Button.js` would have been invisible, which is precisely
// the growth the sentence promised to catch. Walking the packages costs nothing
// and makes the claim true.
const PACK_ROOTS = ['../node_modules/@civitai/components', '../node_modules/@civitai/blocks-react'];

describe('skin coverage of every token that reaches this app', () => {
  const appUsed = new Set<string>();
  for (const f of sourceFiles(SRC)) {
    if (f.endsWith('skin.css')) continue; // the definitions, not a consumption
    for (const m of decomment(readFileSync(f, 'utf8')).matchAll(/var\(\s*(--civitai-color-[\w-]+)/g)) {
      appUsed.add(m[1]);
    }
  }

  const packUsed = new Set<string>();
  const packFilesScanned: string[] = [];
  for (const root of PACK_ROOTS) {
    const dir = fileURLToPath(new URL(root, import.meta.url));
    for (const f of sourceFiles(dir, [], /\.(css|js|mjs|cjs)$/)) {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('--civitai-color-')) continue;
      packFilesScanned.push(f);
      for (const m of src.matchAll(/var\(\s*(--civitai-color-[\w-]+)/g)) packUsed.add(m[1]);
    }
  }

  it('found tokens in BOTH populations (positive control — a zero passes everything)', () => {
    expect(appUsed.size).toBeGreaterThanOrEqual(6);
    // If this goes to zero the packages moved their stylesheets and the scan is
    // reading nothing, which looks exactly like "the pack references no tokens".
    expect(packUsed.size).toBeGreaterThanOrEqual(6);
    // ...and the walk really did reach more than the two files the previous
    // version hardcoded, which is the whole point of widening it.
    expect(packFilesScanned.length).toBeGreaterThanOrEqual(3);
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

// 🔴 THE RUBRIC LINE `noHardcodedThemeColour` IS A CLAIM ABOUT THIS SET, AND IT
// HAS NOW BEEN WRONG TWICE. First it said the only literals outside skin.css were
// the stage chrome and the mark (there were seven other files). The correction
// then listed SEVEN files including ModeSwitcher.tsx — which the very same commit
// had emptied, four lines earlier in its own diff. A hand-counted set in prose is
// a claim nothing checks, so it drifts every time someone edits a colour. This
// pins it: the rubric quotes what this test enumerates.
describe('which files carry colour literals — the rubric line, made checkable', () => {
  // Comment-stripped, because a hex inside a comment explaining a hex is not one.
  const stripAll = (s: string) =>
    decomment(s)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');

  // 🔴 `.css` IS SCANNED, AND OMITTING IT MADE THE FIRST VERSION VACUOUS. That
  // version filtered to `/\.tsx?$/`, so no stylesheet was ever examined — and
  // `src/index.css` is exactly where a theme literal had already lived once. An
  // audit measured it: restoring `var(--civitai-color-surface-2, #e9ecef)` into
  // index.css:91 — the literal that file's own comment says "is GONE" because it
  // "would have painted a cold gray block into a rose UI" — left the suite
  // 450/450 green. The test that read as the guard against that regression was
  // not one. `skin.css` is excluded because it is the sanctioned home.
  const carriers = sourceFiles(SRC)
    .filter((f) => !f.endsWith('skin.css'))
    .filter((f) => /#[0-9a-fA-F]{3,8}\b|rgba?\(|'(?:black|white)'/.test(stripAll(readFileSync(f, 'utf8'))))
    .map((f) => f.slice(SRC.length))
    .sort();

  it('is exactly the documented set — two exceptions plus four media-overlay files', () => {
    // 🔴 SHRANK BY ONE IN 0.2.11, AND THE SHRINK IS THE POINT. CollectionGrid.tsx
    // left this set because its only colour literals lived in the tap-to-reveal
    // overlay that the maturity rework deleted (a white-on-rgba scrim). An
    // enumerated set is what makes a deletion visible as a deletion instead of a
    // number quietly going down in prose nobody checks.
    //
    // 🔴 SHRANK AGAIN IN 0.2.15, AND THIS GUARD IS HOW THE CHANGE WAS NOTICED.
    // `components/styles.ts` left the set: `iconBtn` had been carrying its own
    // copies of the `stage` values — and they had already DRIFTED, its border
    // reading `rgba(255,255,255,0.25)` against `stage.chromeBtnBorder`'s
    // `rgba(255,255,255,0.28)`. It now reads the tokens instead of restating
    // them, so it holds no literals at all. The transport controls did not stop
    // being white-on-scrim; they stopped being a SECOND PLACE that decides what
    // white-on-scrim means.
    //
    // 🔴 SHRANK BY ONE MORE IN 0.2.15, AND ONLY THE MERGED TREE COULD SEE IT.
    // `components/Player.tsx` left the set, and NEITHER branch that emptied it
    // could observe that alone: on `main` that file carried literals in three
    // places, the transport work took two (the `Loader color="#fff"` and the
    // elapsed-time `textShadow`) and the tip consolidation took the third (the
    // `#fff` badge on the deleted overlay rail). Each branch was green on its
    // own because the other's literals were still there; merged, the file holds
    // none and this enumerated set is what said so. That is the guard working —
    // a shrink is visible as a shrink instead of a number quietly going down.
    expect(carriers).toEqual([
      'components/BrandMark.tsx', // DOCUMENTED: an identity, invariant across themes
      'components/CollectionViewer.tsx',
      'components/Maturity.tsx',
      'components/toast.tsx',
      'theme.ts', // DOCUMENTED: `stage` — reads against arbitrary media, not a page bg
    ]);
    // The count the rubric quotes. 7 → 6 in 0.2.15 when `components/styles.ts`
    // stopped restating the `stage` values and started reading them, then 6 → 5
    // when `components/Player.tsx` lost its last literal.
    expect(carriers.length).toBe(5);
    // The media-overlay subset, i.e. the set minus the two documented exceptions.
    // 5 → 4 in 0.2.15 with `components/styles.ts`, then 4 → 3 with `Player.tsx`.
    expect(carriers.filter((f) => f !== 'theme.ts' && f !== 'components/BrandMark.tsx')).toHaveLength(3);
  });

  // 🔴 NOT a restatement of the list above — that one would pass with `.css`
  // unscanned, which is how the vacuous version got shipped. This asserts the
  // stylesheets specifically, so it fails for a reason the list cannot.
  it('no STYLESHEET carries a colour literal — index.css included', () => {
    const sheets = sourceFiles(SRC).filter((f) => f.endsWith('.css') && !f.endsWith('skin.css'));
    expect(sheets.length).toBeGreaterThan(0); // positive control: we found stylesheets
    for (const f of sheets) {
      expect({ file: f.slice(SRC.length), literals: stripAll(readFileSync(f, 'utf8')).match(/#[0-9a-fA-F]{3,8}\b/g) }).toEqual({
        file: f.slice(SRC.length),
        literals: null,
      });
    }
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
// the ways this skin can be silently switched off. FOUR are numbered below
// against the THREE named at the top of this file, and the extra one is (2)
// SPECIFICITY — a real inertness route (a bare `[data-pc-skin]` ties with
// @civitai/theme and loses on source order, skin.css's selector note), which the
// header's "three mechanisms" does not count.
//
// ⚠ An earlier draft of this line explained the four as "the layer trap has an
// opposite-facing half (see (1))". That was FALSE twice over: the mirror half
// (index.css must BE layered) lives INSIDE (1) and is not one of the four, and it
// is not a way this SKIN is switched off at all — it is about the app's reset
// stripping the PACK. Recorded rather than silently replaced, because reaching
// for a fresh rationale is what produced it.
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
  // 🔴 THIS CHECK HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS. Both are recorded
  // because the second was introduced by the fix for the first, and a reader who
  // knows only one of them will re-derive the other.
  //
  //   v1 (too narrow) — removed the layer block with
  //   `.replace(/@layer\s+app\s*\{[\s\S]*\n\}/, '')`. `[\s\S]*` is GREEDY, so it
  //   backtracked to the LAST `\n}` in the file and the replace ate everything
  //   from `@layer app {` to EOF: a rule appended AFTER the layer was deleted
  //   before scanning and never checked.
  //   🔴 The reproduction recorded for this was ALSO wrong, and re-deriving it
  //   gives a RED that reads as "the finding was imagined". The greedy pattern
  //   ends at `\n}`, so it needs a `}` at the START OF A LINE: a ONE-LINE rule at
  //   EOF (`.x { border: 0 }`) supplies none, the replace stops at the @keyframes
  //   closer, and v1 CATCHES it. Only the MULTI-LINE shape reproduces.
  //
  //   v2 (too wide) — fixed the walk, then stripped at-rules with
  //   `/@[\w-]+[^{;]*\{(?:[^{}]|\{[^{}]*\})*\}/g` to stop `@keyframes` stops
  //   (`0% {`) reading as selectors. That drops EVERY at-rule, contents included,
  //   so an unlayered `@media screen { * { border-width: 0 } }` became invisible
  //   — in BOTH positions, a hazard v1 had caught. Net regression, under a title
  //   widened to say EVERY style rule.
  //
  // v3: brace-match the layer, strip ONLY @keyframes (the one at-rule whose
  // children are not style rules), and scan everything else — including the
  // inside of an @media, which is exactly where a reset likes to hide.
  const styleRulesOutsideLayer = (css: string): string[] => {
    const open = css.search(/@layer\s+app\s*\{/);
    if (open === -1) return ['<no @layer app block>'];
    let depth = 0;
    let close = -1;
    for (let i = css.indexOf('{', open); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close === -1) return ['<unbalanced @layer app block>'];
    const outside = (css.slice(0, open) + css.slice(close + 1))
      // @keyframes ONLY. Its stops are shaped like selectors but are not style
      // rules and take no part in the cascade. Every other at-rule keeps its body.
      .replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    // 🔴 v4. A style rule is a `{` whose prelude — the text back to the previous
    // `{`, `}` or `;` — is non-empty. Walked, not matched with a regex.
    //
    // v3 scanned with `/(^|\n)\s*[^@\s}][^{}]*\{/`, anchored to a LINE START, so it
    // only ever saw a rule that BEGINS a line: a one-line
    // `@media screen { * { border-width: 0 } }` was missed in both positions,
    // while the test title said EVERY style rule and the commit said an @media body
    // was "scanned like anything else". Neither was true for that spelling, and
    // nothing in this repo normalises hand-written CSS (no prettier, no stylelint),
    // so the one-line form is a real thing to write. Reverting to v3 turns exactly
    // the four one-line controls below red — measured.
    //
    // ⚠ AND A REGEX CANNOT DO THIS, which is why it is a loop: a pattern that
    // MATCHES the preceding delimiter also CONSUMES it, so the next rule has no
    // delimiter left to match against. An `@media { * { … } }` then reports its own
    // (empty) at-rule prelude and silently drops the `*` rule one character later.
    //
    // ⚠ A `.replace(/@[\w-]+[^{;]*\{/g, '{')` step sat here for one revision, to
    // strip at-rule preludes so the reported name would be the inner selector.
    // Measured and REMOVED: with the walk in place it changes NO verdict — all four
    // one-line controls pass without it. It only altered which prelude got named
    // (`@media screen` rather than `*`), and an extra line whose purpose has to be
    // explained is worse than a slightly blunter failure message.
    const preludes: string[] = [];
    let cut = 0;
    for (let i = 0; i < outside.length; i += 1) {
      const ch = outside[i];
      if (ch === '{') {
        const prelude = outside.slice(cut, i).trim();
        if (prelude.length > 0) preludes.push(prelude);
        cut = i + 1;
      } else if (ch === '}' || ch === ';') {
        cut = i + 1;
      }
    }
    return preludes;
  };

  it('index.css IS layered, and EVERY style rule is inside the layer', () => {
    expect(decomment(INDEX_CSS)).toMatch(/@layer\s+app\s*\{/);
    expect(styleRulesOutsideLayer(decomment(INDEX_CSS))).toEqual([]);
  });

  // 🔴 THE CONTROL RUNS THE REAL FUNCTION. The previous version re-implemented the
  // brace walk inline and asserted its own copy, so it passed with the v1 greedy
  // defect fully restored — a control that cannot fail when the guard regresses,
  // which is the one property it existed to provide. Feeding mutated CSS through
  // `styleRulesOutsideLayer` is what makes a future green worth something.
  // 🔴 THE SHAPES ARE THE POINT, AND CHOOSING THEM BADLY IS HOW THIS GUARD KEEPS
  // SHIPPING HALF-BLIND. Round 2's four controls were all drawn from spellings the
  // regex already handled, which is the same axis-blindness they were written to
  // close — an audit then found the one-line `@media` form missed in BOTH
  // positions. Vary the SPELLING (line breaks, at-rule kind, selector shape), not
  // just the position.
  it.each([
    ['appended AFTER the layer, multi-line', (css: string) => `${css}\n.pc-evil {\n  border-width: 0;\n}\n`],
    ['appended AFTER the layer, one-line', (css: string) => `${css}\n.pc-evil { border-width: 0; }\n`],
    ['placed BEFORE the layer', (css: string) => `.pc-evil {\n  border-width: 0;\n}\n${css}`],
    [
      'inside a multi-line unlayered @media',
      (css: string) => `${css}\n@media screen {\n  * {\n    border-width: 0;\n  }\n}\n`,
    ],
    // the four the audit measured as MISSED
    ['inside a ONE-LINE unlayered @media, after', (css: string) => `${css}\n@media screen { * { border-width: 0 } }\n`],
    ['inside a ONE-LINE unlayered @media, before', (css: string) => `@media screen { * { border-width: 0 } }\n${css}`],
    ['inside a one-line @supports', (css: string) => `${css}\n@supports (display:grid) { * { border-width: 0 } }\n`],
    [
      'inside a one-line @media with a grouped selector',
      (css: string) => `${css}\n@media print { html, body { border-width: 0 } }\n`,
    ],
    // trailing on the same line as the layer's own closing brace
    ['appended on the layer closer line', (css: string) => `${css.replace(/\}\s*$/, '')}\n} .pc-evil { border-width: 0; }\n`],
  ])('the check SEES an unlayered rule %s', (_shape, mutate) => {
    const found = styleRulesOutsideLayer(mutate(decomment(INDEX_CSS)));
    expect(found.length).toBeGreaterThan(0);
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
