/**
 * The theme to PAINT WITH before `ready`.
 *
 * 🔴 WHY THIS EXISTS. `useBlockContext().theme` is a SENTINEL before `ready`, not a
 * signal: the SDK's pre-init snapshot hardcodes `theme: 'light'`
 * (@civitai/blocks-react `dist/internal/transport.js`, EMPTY_SNAPSHOT) and the hook
 * returns it unchanged, so its value is indistinguishable from a host that really is
 * light. Painting with it makes every viewer light until BLOCK_INIT lands — and
 * because index.html's boot skeleton is dark, that is dark → light → dark, a NEW
 * flash introduced at exactly the moment `bootSkeleton: true` stands the host's veil
 * down. Never branch on `theme` in a `!ready` path; use this instead.
 *
 * 🔴 THE ATTRIBUTE READ IS FORWARD-COMPATIBLE, NOT LOAD-BEARING HERE. This app's
 * pinned SDK cannot decode the init fragment, so index.html ships no inline reader
 * and nothing sets `data-civitai-boot-theme` today — the OS query below is what
 * actually answers, matching the stylesheet's `@media (prefers-color-scheme: light)`
 * exactly. The attribute branch is kept so that adding the reader later needs no
 * change here.
 *
 * Unknown means DARK, here and in index.html and in `<meta name="color-scheme">`.
 */
export type BootTheme = 'dark' | 'light';

export function bootThemeGuess(): BootTheme {
  try {
    const recorded = document.documentElement.getAttribute('data-civitai-boot-theme');
    if (recorded === 'dark' || recorded === 'light') return recorded;
    // The OS guess, asked the same way round as the stylesheet: LIGHT is the
    // positive case, so `no-preference` and any UA without the query land on dark.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  } catch {
    // fall through
  }
  return 'dark';
}

/**
 * The value to stamp on the app root's `data-theme`.
 *
 * After `ready` the HOST's theme is authoritative and wins outright — this helper
 * exists only to keep the pre-`ready` commit off the sentinel.
 */
export function paintTheme(ready: boolean, hostTheme: string | undefined): string {
  return ready && hostTheme ? hostTheme : bootThemeGuess();
}
