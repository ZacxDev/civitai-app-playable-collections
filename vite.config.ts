/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';

/**
 * Where to find a chromium this host can actually execute.
 *
 * 🔴 RESOLVED AT RUN TIME, NEVER WRITTEN DOWN. A `/nix/store/...` path baked into
 * this file is correct exactly until the store is garbage-collected, after which
 * the browser tier fails with a missing-file error that looks nothing like the
 * config bug it is. So: an explicit env override first, then — ON NixOS ONLY —
 * whatever is on PATH. Everywhere else this returns `undefined` deliberately; the
 * reason is in the function body.
 *
 * 🔴 AND PLAYWRIGHT'S OWN BUNDLED CHROMIUM CANNOT RUN ON NixOS — it is a prebuilt
 * binary linked against an FHS loader this system does not have (`stub-ld`), so
 * it dies before it prints anything useful. That is why the executable is
 * injected rather than downloaded, and why `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
 * is set when installing.
 *
 * `chromium` is NOT on PATH by default on this host — run the tier inside
 * `nix-shell -p pnpm chromium`, which is what `pnpm test:browser` documents.
 * Returns `undefined` when nothing is found, which lets Playwright fall back to
 * its own browser on hosts where that works (CI images, macOS, ordinary Linux).
 */
function resolveChromium(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? process.env.CHROMIUM_BIN;
  if (fromEnv) return fromEnv;

  // 🔴 THE PATH FALLBACK IS NixOS-ONLY, DELIBERATELY. Elsewhere — CI images,
  // macOS, ordinary Linux — Playwright's own managed browser is the RIGHT answer,
  // and it is the one its version matrix is tested against. Grabbing whatever
  // binary happens to be called `chromium` on PATH there would silently swap the
  // engine under the tests on some hosts and not others, which is exactly the
  // kind of environment-dependent difference a test suite must not have.
  if (!existsSync('/etc/NIXOS')) return undefined;

  try {
    // `command -v` through a shell would drag in this host's shell startup noise
    // (its hook prints a PR dashboard to stdout, which would land in the path —
    // CLAUDE.md gotcha #19). `which` execs directly and prints one line.
    return execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    // Not on PATH. Playwright will then fail to launch with a legible
    // "Executable doesn't exist at …" — LOUD, which is what we want. A tier that
    // quietly skipped here would report safety it never checked.
    return undefined;
  }
}

const chromiumPath = resolveChromium();

// base MUST be '/' — the platform serves the build output at the root of the
// app's own subdomain and server-owns the manifest iframe.src (the W10 page
// surface iframes the bundle at /apps/run/playable-collections). No path prefix.
export default defineConfig({
  base: '/',
  plugins: [react()],
  // 🔴 REQUIRED BY THE BROWSER TIER, harmless everywhere else. In browser mode the
  // SDK packages and the app can otherwise resolve to DIFFERENT React copies, and
  // the second one has a null dispatcher — the failure surfaces as
  // `Cannot read properties of null (reading 'useState')` from inside a perfectly
  // ordinary component, which reads like a bug in that component rather than a
  // resolution problem.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    // The dev harness fires a fake BLOCK_INIT from window.location.origin and
    // the SDK IframeTransport drops any postMessage whose origin isn't its
    // allowed parent origin. Pin host+port so that origin is stable.
    host: 'localhost',
    port: 5187,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    rollupOptions: { output: { manualChunks: undefined } },
  },
  test: {
    // Two suites in one `vitest run`:
    //  - `node`: pure-logic unit tests (*.test.ts) — no DOM, fast (player
    //            engine, settings, the API client against a mock fetch).
    //  - `dom` : component + hook + e2e tests (*.test.tsx) — jsdom +
    //            testing-library, driving <App/> and usePlayer() against the
    //            SDK's mock host + an injected fake API client.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          // 🔴 REQUIRED, NOT TIDINESS. `*.browser.test.tsx` also matches the
          // include above, so without this the browser specs ALSO run under
          // jsdom — where they fail, because they assert exactly the things
          // jsdom cannot do (real layout, cascade layers). Measured: 4 failures
          // the first time the browser tier was added without this line.
          exclude: ['src/**/*.browser.test.tsx'],
          setupFiles: ['./src/test-setup.ts'],
        },
      },
      {
        // 🔴 `browser`: a REAL engine, because the other two structurally cannot
        // see a whole class of defect. jsdom has no layout engine — every
        // `getBoundingClientRect()` is 0 — and no cascade layers, so a test for
        // a layout shift or for a themed control passes there whether or not the
        // code works. That is not a gap in coverage, it is coverage that reports
        // safety it never checked.
        //
        // Specs live in `src/**/*.browser.test.tsx`, deliberately a DIFFERENT
        // suffix from the jsdom tier: `*.test.tsx` is matched by `dom` above, and
        // a file that ran in both would be silently asserting two different
        // things about the same name.
        extends: true,
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.tsx'],
          browser: {
            enabled: true,
            headless: true,
            // 🔴 In vitest 4 the provider is a FACTORY from its own package
            // (`@vitest/browser-playwright`), not the string 'playwright' — that
            // string is the vitest 3 spelling and type-errors here. Passing
            // `launchOptions.executablePath` undefined is meaningful: it means
            // "let Playwright pick its own browser", which is correct anywhere
            // the bundled one runs (CI images, macOS, ordinary Linux).
            provider: playwright({ launchOptions: { executablePath: chromiumPath } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
