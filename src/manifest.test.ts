import { describe, expect, it } from 'vitest';

import { BLOCK_SCOPES } from '@civitai/app-sdk/blocks';

import pkg from '../package.json';
import { manifest, validateManifest } from './manifest.js';

describe('block.manifest.json', () => {
  it('declares the 6 required scopes (no block:settings:*, no collections:write:self)', () => {
    expect(manifest.scopes).toEqual([
      'collections:read:self',
      'collections:read:private',
      'social:tip:self',
      'buzz:read:self',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
    ]);
    // 🔴 `collections:write:self` was DROPPED in 0.2.10 and must not come back.
    // Following moved to the host-mediated bridge, which needs no scope: the
    // host calls the session-authed procedure and self-binds the viewer. Re-adding
    // the scope would re-declare a capability the app no longer uses, and the
    // manifest `scopes` list is exactly what a moderator reads before install and
    // what the viewer inspects afterwards.
    expect(manifest.scopes).not.toContain('collections:write:self');
    // block:settings:* was removed — a page app has no installer, so the mint C8
    // gate 403s when they're declared.
    expect(manifest.scopes).not.toContain('block:settings:read');
    expect(manifest.scopes).not.toContain('block:settings:write');
  });

  it('every declared scope is a first-class SDK block scope (0.17.0)', () => {
    const known = new Set<string>(Object.values(BLOCK_SCOPES));
    for (const scope of manifest.scopes as string[]) {
      expect(known.has(scope)).toBe(true);
    }
  });

  it('passes defineBlock once augmented to the full runtime shape', () => {
    const validated = validateManifest();
    // All 7 scopes validate directly now (incl. the 4-segment shared-storage
    // ones and the consent-gated private read) — no exemption needed.
    expect(validated.scopes).toEqual(manifest.scopes);
    expect(validated.scopes).toContain('apps:storage:shared:read');
    expect(validated.scopes).toContain('collections:read:private');
  });

  it('is a page app at "/" with NO manifest settings block (settings are localStorage-local)', () => {
    expect((manifest.page as { path: string }).path).toBe('/');
    expect(manifest.settings).toBeUndefined();
  });

  // 🔴 This was a LITERAL (`is version 0.2.2` / `toBe('0.2.2')`). It rots on every
  // version bump by construction: the 0.2.3 tagline release moved the manifest and
  // left the literal behind, turning `main` red on a bump that broke nothing. A
  // permanently-red gate is worse than no gate — it trains everyone to merge
  // through it, and the next real defect arrives looking exactly like this one.
  // The sibling app hit this same assertion and fixed it the same way
  // (civitai-app-model-benchmarking#5).
  //
  // The literal also pinned nothing worth knowing; "the version is the version"
  // teaches no reader anything. The invariant that MATTERS is that the manifest
  // and the package agree — the store reads one, the build reads the other, and a
  // bump touching only one is a real shippable defect. That cannot rot on a bump,
  // and it still fires when someone bumps just one of the two.
  it('keeps block.manifest.json and package.json versions in lockstep', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version).toBe(pkg.version);
  });
});
