// The inline boot styles in index.html hardcode colour literals. Everything else in
// this app is `var(--civitai-*)` with zero hardcoded colour (src/theme.ts), and that
// is deliberate — but the boot window is the one place a var is unusable, because
// the stylesheets that define those tokens are render-blocking <link>s that have not
// loaded yet. These tests keep that necessary duplication honest: every literal is
// asserted against the file that owns the value, per region, so a change there fails
// here instead of shipping a colour jump at handoff.
//
// 🔴 THE SOURCE OF TRUTH MOVED IN 0.2.9, AND THAT IS THE POINT OF THIS FILE.
// Until 0.2.8 this app was `brandDepth: accent`, so the boot literals were copies of
// the INSTALLED `@civitai/theme` and this suite asserted them against that package.
// The app is now `brandDepth: skin`: src/skin.css overrides those same token VALUES,
// so the package is no longer what the first React commit paints. Left pointed at
// the package, every assertion below would still have passed — while the viewer got
// a platform-grey boot that snapped to rose at handoff, which is exactly the defect
// this suite exists to prevent. It now reads src/skin.css.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const INDEX_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** The app's own palette — see the note above; NOT @civitai/theme. */
const SKIN_CSS = readFileSync(new URL('./skin.css', import.meta.url), 'utf8');

/**
 * The inline `<style>` body ONLY.
 *
 * 🔴 EVERY CSS LOOKUP GOES THROUGH THIS, not the raw file. Searching the whole
 * document for `@media (prefers-color-scheme: light)` can match a PROSE mention of
 * it in a comment rather than the rule — which is exactly how the first version of
 * the canvas-background test in the pilot app failed at baseline while appearing to
 * kill every mutant. A comment is not a rule.
 */
const BOOT_CSS = (() => {
  const m = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML);
  if (!m) throw new Error('no inline <style> found in index.html');
  return m[1];
})();

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const end = css.indexOf('}', start);
  if (end === -1) throw new Error(`unterminated block: ${selector}`);
  return css.slice(start, end);
}

function tokenValue(css: string, selector: string, prop: string): string {
  const m = new RegExp(`${prop}:\\s*([^;]+);`).exec(block(css, selector));
  if (!m) throw new Error(`${prop} not found in ${selector}`);
  return m[1].trim().toLowerCase();
}

function bootValue(selector: string, prop: string): string {
  return tokenValue(BOOT_CSS, selector, prop);
}

describe('boot token parity with @civitai/theme', () => {
  it('the DARK literals match the package [data-theme=dark] block', () => {
    const body = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme]", '--civitai-color-body');
    const text = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme]", '--civitai-color-text');
    const surface = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme]", '--civitai-color-surface');

    expect(bootValue(':root', '--pc-boot-body')).toBe(body);
    expect(bootValue(':root', '--pc-boot-text')).toBe(text);
    expect(bootValue(':root', '--pc-boot-surface')).toBe(surface);
  });

  it('the LIGHT literals match the package :root block', () => {
    const body = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme='light']", '--civitai-color-body');
    const text = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme='light']", '--civitai-color-text');
    const surface = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme='light']", '--civitai-color-surface');

    const media = BOOT_CSS.slice(BOOT_CSS.indexOf('@media (prefers-color-scheme: light)'));
    expect(tokenValue(media, ':root', '--pc-boot-body')).toBe(body);
    expect(tokenValue(media, ':root', '--pc-boot-text')).toBe(text);
    expect(tokenValue(media, ':root', '--pc-boot-surface')).toBe(surface);
  });

  // 🔴 The load-bearing structural claim a colour-by-colour check cannot make: dark
  // must be what "no information" MEANS. A light value reachable without either the
  // media query or an explicit light signal would make a no-preference viewer boot
  // light while every other layer of this app resolves unknown to dark.
  it('no light value is reachable without an explicit light signal', () => {
    const lightBody = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme='light']", '--civitai-color-body');
    const darkBody = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme]", '--civitai-color-body');
    expect(lightBody).not.toBe(darkBody); // sanity: or this test proves nothing

    expect(bootValue(':root', '--pc-boot-body')).toBe(darkBody);
    expect(bootValue(':root', '--pc-boot-body')).not.toBe(lightBody);

    expect(BOOT_CSS.indexOf('@media (prefers-color-scheme: light)')).toBeGreaterThan(-1);
    // No `@media (prefers-color-scheme: dark)` block: one would invert the default
    // for `no-preference` and for any UA without the query. Scoped to the
    // STYLESHEET — the claim is about rules, not a word in a comment.
    expect(BOOT_CSS).not.toContain('prefers-color-scheme: dark');
  });

  // 🔴 THIS EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT IN THE PILOT APP. The
  // `background` DECLARATION is not decoration: it paints the html canvas, the layer
  // beneath the skeleton. Flipping it to white changed nothing and no test failed.
  it('every html-canvas background matches its region', () => {
    const lightBody = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme='light']", '--civitai-color-body');
    const darkBody = tokenValue(SKIN_CSS, "[data-pc-skin][data-theme]", '--civitai-color-body');

    const baseHtml = BOOT_CSS.indexOf('html {');
    expect(baseHtml).toBeGreaterThan(-1);
    expect(/background:\s*([^;]+);/.exec(BOOT_CSS.slice(baseHtml))?.[1].trim().toLowerCase()).toBe(
      darkBody,
    );

    const mediaAt = BOOT_CSS.indexOf('@media (prefers-color-scheme: light)');
    expect(mediaAt).toBeGreaterThan(-1);
    expect(/background:\s*([^;]+);/.exec(BOOT_CSS.slice(mediaAt))?.[1].trim().toLowerCase()).toBe(
      lightBody,
    );

    // 🔴 NO `data-civitai-boot-theme` OVERRIDE BLOCKS IN THIS APP, deliberately —
    // its pinned SDK cannot decode the init fragment, so index.html ships no inline
    // reader and nothing ever sets that attribute. Asserting override rules here
    // would pin markup that does not exist. See the note at the top of index.html.
    expect(BOOT_CSS).not.toContain('data-civitai-boot-theme');
  });

  // `color-scheme` drives the UA canvas, which paints before ANY of the CSS above.
  // `light dark` would paint a no-preference viewer's canvas white under a dark
  // skeleton.
  it('the color-scheme meta lists dark first', () => {
    expect(INDEX_HTML).toContain('content="dark light"');
    expect(INDEX_HTML).not.toContain('content="light dark"');
  });
});
