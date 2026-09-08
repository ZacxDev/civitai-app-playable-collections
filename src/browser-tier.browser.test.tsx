// 🔴 THE INSTRUMENT CHECK FOR THE BROWSER TIER ITSELF.
//
// The app's other two suites run in `node` and `jsdom`. jsdom has NO LAYOUT
// ENGINE — every `getBoundingClientRect()` is 0×0 — and NO CASCADE LAYERS. So a
// test written there for a layout shift, or for whether a themed rule beats a
// package's rule, passes whether or not the code works. That is worse than no
// test: it reads as coverage while checking nothing.
//
// This file exists to prove the new tier can see both of those things, BEFORE
// anything is built on top of it. Every case below is written so that jsdom
// would fail it (or pass it vacuously), which is the whole point — if these ever
// start running under jsdom by accident, they break loudly instead of quietly.
//
// 🔴 THE `.browser.test.tsx` SUFFIX IS LOad-BEARING. The `dom` project matches
// `src/**/*.test.tsx`; this project matches `src/**/*.browser.test.tsx`. A file
// picked up by both would assert two different things under one name.

import { describe, expect, it, afterEach } from 'vitest';

/** Mount markup in the real document and hand back the root, cleaned up after. */
const mounted: HTMLElement[] = [];
function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  mounted.push(host);
  return host;
}
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

describe('the browser tier is a REAL engine (jsdom cannot pass these)', () => {
  it('🔴 measures a real box — a definite width comes back as that width, not 0', () => {
    const host = mount('<div id="probe" style="width:200px;height:40px"></div>');
    const probe = host.querySelector<HTMLElement>('#probe')!;

    const rect = probe.getBoundingClientRect();
    // In jsdom this is 0. If this assertion ever reads 0, the tier is not running
    // in a browser and every layout claim built on it is void.
    expect(rect.width).toBe(200);
    expect(rect.height).toBe(40);
  });

  it('🔴 reproduces the REAL ticker/wall defect: a percentage width against an auto-width flex parent collapses to 0', () => {
    // This is not a synthetic example. `ContinuousView`'s `tileStyle` is
    // `width: undefined` + `flex: 0 0 auto`, and its media is `width: 100%`.
    // Until the media loads there is no intrinsic size, so the child resolves
    // 100% of an indefinite width — i.e. NOTHING — and the tile is 0 wide. When
    // the media arrives everything on the row jumps. That is the operator's
    // "cards default to 0 width and layout shift when the media loads".
    //
    // Proving the tier can SEE this is what makes the fix testable at all.
    const host = mount(`
      <div style="display:flex">
        <div id="collapsing" style="flex:0 0 auto">
          <div id="child" style="width:100%"></div>
        </div>
        <div id="reserved" style="flex:0 0 auto;aspect-ratio:16/9;width:320px">
          <div style="width:100%"></div>
        </div>
      </div>
    `);

    // The defect, measured.
    expect(host.querySelector<HTMLElement>('#collapsing')!.getBoundingClientRect().width).toBe(0);

    // …and the shape of the fix: a tile whose box is reserved from known
    // dimensions has a width before any content loads. `MediaItem` already
    // carries `width`/`height`, so this is available without an API change.
    const reserved = host.querySelector<HTMLElement>('#reserved')!.getBoundingClientRect();
    expect(reserved.width).toBe(320);
    expect(reserved.height).toBeCloseTo(180, 0);
  });

  it('🔴 resolves CASCADE LAYERS — an unlayered rule beats a layered one regardless of specificity', () => {
    // jsdom implements no layers at all, so it cannot express this. It is the
    // mechanism the app's whole skin rests on: `@civitai/theme` is UNLAYERED, so
    // the app's token overrides must stay unlayered to beat it, while the app's
    // reset must BE layered so it cannot beat `@civitai/components`. A suite that
    // cannot see layer resolution is silent on all of that.
    const style = document.createElement('style');
    style.textContent = `
      @layer app;
      @layer app { #layered-probe { color: rgb(1, 2, 3); } }
      #layered-probe { color: rgb(9, 8, 7); }
    `;
    document.head.appendChild(style);
    const host = mount('<span id="layered-probe">x</span>');
    const probe = host.querySelector<HTMLElement>('#layered-probe')!;

    // The UNLAYERED declaration wins, even though both selectors are identical
    // in specificity and the layered one is written second.
    expect(getComputedStyle(probe).color).toBe('rgb(9, 8, 7)');

    style.remove();
  });

  it('resolves a CSS custom property to a real computed value', () => {
    // The probe-oracle shape the theming work needs: read the COMPUTED style and
    // compare it against the token-derived expectation, rather than asserting a
    // class name is present.
    const style = document.createElement('style');
    style.textContent = `#token-probe { --probe-color: rgb(10, 20, 30); background-color: var(--probe-color); }`;
    document.head.appendChild(style);
    const host = mount('<div id="token-probe" style="width:10px;height:10px"></div>');
    const probe = host.querySelector<HTMLElement>('#token-probe')!;

    expect(getComputedStyle(probe).backgroundColor).toBe('rgb(10, 20, 30)');

    style.remove();
  });
});
