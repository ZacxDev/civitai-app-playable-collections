// Manifest loading + validation.
//
// The committed `block.manifest.json` is a PAGE-APP SOURCE manifest (mirrors the
// notepad / prompt-library convention): it declares `page`, `scopes` etc. and
// OMITS `appId`, `targets`, and `iframe.src` — the platform injects those at
// deploy/serve time.
//
// 🔴 THAT SOURCE SHAPE IS NOW THE SHAPE THE VALIDATOR WANTS, AND IT USED TO BE
// THE OPPOSITE. Until `@civitai/app-sdk@0.49.0` this module AUGMENTED the source
// manifest to a full runtime shape — adding `appId`, a synthetic `app.page`
// target and an `iframe.src` placeholder — because the old hand-written
// `defineBlock` mirror in `@civitai/app-sdk/blocks` required all three. 0.49.0
// replaced that mirror with an Ajv compile of the vendored CANONICAL schema and
// moved the function to the NODE-ONLY `@civitai/app-sdk/manifest` subpath (the
// browser-facing `./blocks` surface keeps zero runtime dependencies; Ajv is an
// optional peer, which is why `ajv` is a devDependency here).
//
// ⚠️ `ajv` IS DECLARED DELIBERATELY EVEN THOUGH THE INSTALL CURRENTLY WORKS
// WITHOUT IT, and the reason is worth keeping. Measured: with no `ajv` entry in
// `package.json`, a clean `pnpm install`, a `pnpm install --frozen-lockfile` and
// `src/manifest.test.ts` (10/10) all pass with a COLD vite dep cache — because
// pnpm auto-installs the optional peer, pins it in the lockfile, and
// `defineBlock.js`'s bare `import Ajv2020 from 'ajv/dist/2020.js'` then resolves
// out of pnpm's HIDDEN HOISTED STORE (`node_modules/.pnpm/node_modules/ajv`).
// That resolution is an artefact of this pnpm configuration, not a contract: the
// import is STATIC and not optional, and `@civitai/app-sdk/manifest`'s own
// header says "install it where you use this: `pnpm add -D ajv`". So the
// declaration is the claim; the hoist is luck.
//
// Two consequences, both measured against the installed 0.49.0 rather than read
// off a changelog:
//   - the RAW committed manifest is ACCEPTED as-is — `appId` and `targets` are
//     not required of a page app;
//   - `iframe.src` is now REJECTED outright ("manifest.iframe.src is
//     SERVER-OWNED — the platform assigns it during build/approve"), so the old
//     augmentation would turn this gate permanently red while changing nothing
//     about the app.
// So the augmentation is gone and the committed file is validated directly.
// That is strictly MORE faithful: what `defineBlock` now sees is byte-for-byte
// what `civitai app submit` uploads, not a locally-synthesised variant of it.
//
// NOTE: `@civitai/app-sdk@0.17.0` relaxed `BLOCK_SCOPE_PATTERN` to accept 4
// segments and added `apps:storage:shared:*` + `collections:*` to `BLOCK_SCOPES`
// — so every scope we declare validates directly. The earlier
// `KNOWN_INCOMING_SCOPES` strip-before-validate workaround is gone.

import { defineBlock } from '@civitai/app-sdk/manifest';
import type { BlockManifest } from '@civitai/app-sdk/blocks';

import rawManifest from '../block.manifest.json';

/** The raw committed manifest (page-app source shape). */
export const manifest = rawManifest as unknown as Record<string, unknown>;

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
}

/**
 * Validate the committed page-app source manifest with the SDK's `defineBlock`
 * — an Ajv compile of the canonical `block.manifest.json` schema plus the
 * prose-only server rejections the SDK calls `SCHEMA_DIVERGENCES`. Returns the
 * validated manifest; throws `BlockManifestError` (with a `.field` dot-path) on
 * any violation.
 */
export function validateManifest(source: Record<string, unknown> = manifest): BlockManifest {
  return defineBlock({ manifest: source as unknown as BlockManifest });
}
