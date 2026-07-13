// Manifest loading + validation.
//
// The committed `block.manifest.json` is a PAGE-APP SOURCE manifest (mirrors the
// notepad / prompt-library convention): it declares `page`, `scopes`, `settings`
// etc. but OMITS `appId`, `targets`, and `iframe.src` — the platform injects
// those at deploy/serve time. The published SDK's `defineBlock` validates the
// FULL runtime shape, so to get a real `defineBlock` gate we augment the source
// manifest to the full shape before validating.
//
// 🔴 defineBlock scope gap (TODO(wave2)): the published SDK 0.13.0's
// `BLOCK_SCOPE_PATTERN` is `/^[a-z]+:[a-z]+:[a-z]+$/` — exactly THREE colon
// segments. Two of our declared scopes don't yet pass the published validator:
//   - `apps:storage:shared:read` / `apps:storage:shared:write` — FOUR segments,
//     so they fail the pattern outright (even though they are the EXISTING
//     shared-storage scopes the plan reuses).
// (`collections:read:self` / `collections:write:self` are three-segment and DO
// pass the pattern — they're simply absent from the SDK's `BLOCK_SCOPES` enum,
// which `defineBlock` does not check. They validate fine here.)
// Until `@civitai/app-sdk` ships these (Wave 1A canonical schema + Wave 2 SDK
// sync), we strip the known-incoming scopes before calling `defineBlock`, then
// validate them against a local allowlist + a relaxed pattern.

import { defineBlock } from '@civitai/app-sdk/blocks';
import type { BlockManifest } from '@civitai/app-sdk/blocks';

import rawManifest from '../block.manifest.json';

/** The raw committed manifest (page-app source shape). */
export const manifest = rawManifest as unknown as Record<string, unknown>;

/**
 * Scopes not yet accepted by the published `defineBlock` pattern. Remove this
 * list once `@civitai/app-sdk` ships the shared-storage (4-segment) scopes —
 * TODO(wave2). Each MUST still be a real, server-recognized scope.
 */
export const KNOWN_INCOMING_SCOPES = [
  'apps:storage:shared:read',
  'apps:storage:shared:write',
] as const;

/** Relaxed pattern: 3 OR 4 lowercase colon segments (covers apps:storage:shared:*). */
const RELAXED_SCOPE_PATTERN = /^[a-z]+(:[a-z]+){2,3}$/;

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
}

/**
 * Augment the page-app source manifest to the full `BlockManifest` runtime shape
 * (adding the platform-injected `appId`, `targets`, `iframe.src`) and strip the
 * known-incoming scopes, so the published `defineBlock` can validate everything
 * it's able to. Returns the validated (augmented) manifest.
 *
 * Throws if the manifest is malformed OR if a known-incoming scope isn't a
 * plausible scope string (guards against a typo hiding behind the exemption).
 */
export function validateManifest(source: Record<string, unknown> = manifest): BlockManifest {
  const declaredScopes = Array.isArray(source.scopes) ? (source.scopes as string[]) : [];

  // Every known-incoming scope must actually appear in the manifest and look
  // like a real scope — the exemption is not a licence to typo.
  for (const scope of KNOWN_INCOMING_SCOPES) {
    if (!declaredScopes.includes(scope)) {
      throw new ManifestValidationError(
        `known-incoming scope "${scope}" is expected in the manifest but missing`,
      );
    }
  }
  for (const scope of declaredScopes) {
    if (!RELAXED_SCOPE_PATTERN.test(scope)) {
      throw new ManifestValidationError(`scope "${scope}" is not a valid scope string`);
    }
  }

  const iframeSource = (source.iframe ?? {}) as Record<string, unknown>;

  const augmented: BlockManifest = {
    ...(source as object),
    // Platform-injected at deploy time; placeholders for local validation.
    appId: (source.appId as string) ?? 'app_local_playable_collections',
    // Page apps have no manifest `targets`; the platform derives an `app.page`
    // target from `page`. Synthesize one so defineBlock's required-field check
    // passes.
    targets: (source.targets as unknown[]) ?? [{ slotId: 'app.page', priority: 100 }],
    iframe: {
      ...iframeSource,
      src: (iframeSource.src as string) ?? 'https://playable-collections.civit.ai/',
    },
    // defineBlock validates the PATTERN of every scope, so exclude the
    // known-incoming (4-segment) ones it can't accept yet.
    scopes: declaredScopes.filter(
      (s) => !(KNOWN_INCOMING_SCOPES as readonly string[]).includes(s),
    ),
  } as BlockManifest;

  return defineBlock({ manifest: augmented });
}
