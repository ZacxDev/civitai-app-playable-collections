// 🔴 THE LAYOUT-SHIFT GUARD, AND IT CAN ONLY LIVE IN THE BROWSER TIER.
//
// The defect: `tileStyle` had no width and `mediaEl` was `width: '100%'`, so in
// the ticker (a flex ROW, tiles `flex: '0 0 auto'`) the percentage resolved
// against an INDEFINITE width — 0 — until the media loaded, at which point the
// tile snapped to its intrinsic size and everything after it on the row jumped.
// The operator's report: "cards default to 0 width and layout shift when the
// media loads".
//
// 🔴 THIS IS UNTESTABLE IN jsdom, WHICH IS THE WHOLE REASON THE BROWSER TIER
// EXISTS. jsdom reports 0 for every `getBoundingClientRect()`, so an assertion
// like "the tile has a width" is FALSE THERE EVEN WHEN THE CODE IS CORRECT, and
// an assertion like "the width did not change" is TRUE THERE EVEN WHEN IT IS
// BROKEN — 0 before, 0 after. Both directions are wrong. Do not "simplify" this
// file into the `dom` project.
//
// The media never loads here: the URLs are fake. That is deliberate and is
// exactly the state being asserted — the box must be right BEFORE any byte
// arrives. A tile that is correctly sized with no media is a tile that cannot
// shift when media appears.

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { SFW_LEVELS } from '@civitai/app-sdk/blocks';

import { ContinuousView } from './ContinuousView.js';
import { palette } from '../theme.js';
import type { MediaItem } from '../types.js';

// 🔴 THE CEILING HOOK IS STUBBED, AND THE TRANSPORT IS DELIBERATELY ABSENT.
//
// `ContinuousView` calls `useViewerCeiling()`, which reaches the SDK's singleton
// IframeTransport. Rendering bare throws `allowedParentOrigins must contain at
// least one entry` (the real allowlist is baked in at BUILD time and empty under
// test), so this file first used `<Harness>` + a per-test transport reset, the
// way the jsdom tier does.
//
// 🔴 THAT DOES NOT WORK IN BROWSER MODE, AND CI IS WHERE IT SHOWED. vitest browser
// mode runs each spec INSIDE AN IFRAME, so the transport waits for BLOCK_INIT from
// `window.parent` — the vitest runner — and the mock host's handshake never
// reaches it. Under jsdom `window.parent === window`, which is exactly why the
// same pattern is fine there. The wait then rejected 10s later with nothing
// listening: the job failed with `619 passed` and `1 error` on screen, and it
// passed locally only because the run finished inside 10s. Reproduced locally by
// holding the run open past the timeout, then fixed.
//
// The subject here is LAYOUT. The ceiling is scaffolding, so it is stubbed
// outright — no transport, no host, nothing to time out. This is not the vacuous
// kind of mock: nothing below asserts anything about maturity filtering, and
// `filterToCeiling` keeps every fixture at this ceiling, so the surface under
// measurement is the full item list.
vi.mock('../lib/viewer-maturity.js', () => ({ useViewerCeiling: () => SFW_LEVELS }));

afterEach(cleanup);

const c = palette();

function item(mediaId: number, width = 1600, height = 900): MediaItem {
  return {
    mediaId,
    type: 'image',
    // Deliberately unresolvable: nothing must depend on a load completing.
    url: `https://cdn.invalid/never-loads-${mediaId}.jpg`,
    width,
    height,
    creator: { userId: 1, username: 'someone' },
    nsfwLevel: 1,
  };
}

function renderSurface(orientation: 'horizontal' | 'vertical', items: MediaItem[]) {
  return render(
    <ContinuousView
      orientation={orientation}
      items={items}
      muted
      scrollSpeed={0}
      reducedMotion
      paused
      autoplayCap={0}
      c={c}
      onTapItem={vi.fn()}
      onTogglePause={vi.fn()}
    />,
  );
}

/** Primary (non-clone) tiles only — the surface renders a second copy for the loop. */
function tiles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="continuous-tile"]'));
}

describe('ContinuousView reserves each tile before its media loads', () => {
  it('🔴 TICKER: a tile has a real width with NO media loaded', () => {
    const { container } = renderSurface('horizontal', [item(1), item(2), item(3)]);
    const all = tiles(container);
    expect(all.length).toBeGreaterThanOrEqual(3);

    for (const t of all) {
      const r = t.getBoundingClientRect();
      // Pre-fix this was 0 — the assertion that fails on the old code.
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
  });

  it('🔴 WALL: a tile has a real width AND height with NO media loaded', () => {
    // Ticker and wall share `tileStyle` but lay out completely differently (flex
    // row vs grid), so a pass in one is not evidence about the other. The wall
    // gets its WIDTH from the grid column even pre-fix; its HEIGHT was the part
    // that collapsed.
    const { container } = renderSurface('vertical', [item(1), item(2), item(3), item(4)]);
    const all = tiles(container);
    expect(all.length).toBeGreaterThanOrEqual(4);

    for (const t of all) {
      const r = t.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
  });

  it('the reserved box MATCHES the item’s own aspect ratio, not a guess', () => {
    // 16:9 in, 16:9 out — this is what makes the reservation correct rather than
    // merely non-zero. A tile that reserved an arbitrary box would still pass the
    // two cases above and still shift when the real media arrived.
    const { container } = renderSurface('horizontal', [item(1, 1600, 900)]);
    const r = tiles(container)[0]!.getBoundingClientRect();
    expect(r.width / r.height).toBeCloseTo(16 / 9, 1);
  });

  it('a PORTRAIT item reserves a portrait box — the ratio is read, not hardcoded', () => {
    // The control for the case above: if the code pinned one ratio, both would
    // measure 16:9 and the previous test would pass vacuously.
    const { container } = renderSurface('horizontal', [item(1, 900, 1600)]);
    const r = tiles(container)[0]!.getBoundingClientRect();
    expect(r.width / r.height).toBeCloseTo(9 / 16, 1);
  });

  it('🔴 JUNK DIMENSIONS still render a sane box — not 0, not absurd', () => {
    // `MediaItem.width/height` are whatever the API sent. Zero, negative and
    // absurd ratios must all degrade to something renderable, or the fix trades
    // a shift for a broken surface.
    const { container } = renderSurface('horizontal', [
      item(1, 0, 0),
      item(2, -5, 10),
      item(3, 100000, 1),
      item(4, Number.NaN, 900),
    ]);
    for (const t of tiles(container)) {
      const r = t.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
      // Clamped: nothing reserves a box taller or wider than 3:1 either way.
      const ratio = r.width / r.height;
      expect(ratio).toBeGreaterThanOrEqual(1 / 3 - 0.05);
      expect(ratio).toBeLessThanOrEqual(3 + 0.05);
    }
  });

  it('tiles on a ticker row do not overlap or stack — the row genuinely lays out', () => {
    // A positive control on the MEASUREMENT itself: if every tile reported the
    // same box, the numbers above would be an artefact rather than a layout.
    const { container } = renderSurface('horizontal', [item(1), item(2), item(3)]);
    const xs = tiles(container).map((t) => t.getBoundingClientRect().left);
    const unique = new Set(xs.map((x) => Math.round(x)));
    expect(unique.size).toBe(xs.length);
  });
});
