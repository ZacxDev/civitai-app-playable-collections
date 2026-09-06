// The app's mark, inline, for the browse header.
//
// 🔴 THESE THREE COLOURS ARE DELIBERATELY NOT TOKENS, and that is the same call
// `stage` in src/theme.ts makes for the media-player chrome. A mark is an
// identity, not a surface: it must be the SAME rose in light and dark, or it
// stops being the thing people recognise from the store listing. Everything
// around it flips; this does not.
//
// The geometry and the hexes are copied from brand/icon.svg, which the brand kit
// names as the source of truth for the icon ("Vector sources are the source of
// truth… if you change a mark, regenerate rather than editing a raster").
// src/brandMark.test.ts asserts this component against that file, so the two
// cannot drift apart silently — the failure mode otherwise is an app wearing a
// slightly different mark than its own store icon, which nobody would ever catch
// by looking at one of them.

/** Plate / disc / triangle, exactly as authored in brand/icon.svg. */
export const BRAND_PLATE = '#FA6478';
export const BRAND_DISC = '#F82440';
export const BRAND_GLYPH = '#FFF0F2';

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      // Decorative: the <h1> beside it already names the app, so announcing the
      // mark as well would read the name twice.
      aria-hidden="true"
      focusable="false"
      data-testid="brand-mark"
      style={{ borderRadius: 'calc(var(--civitai-radius) * 0.8)', display: 'block', flex: '0 0 auto' }}
    >
      <rect width="1024" height="1024" fill={BRAND_PLATE} />
      <circle cx="512" cy="512" r="340" fill={BRAND_DISC} />
      <polygon points="442,382 442,642 682,512" fill={BRAND_GLYPH} />
    </svg>
  );
}
