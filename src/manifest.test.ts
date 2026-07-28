import { describe, expect, it } from 'vitest';

import { BLOCK_SCOPES } from '@civitai/app-sdk/blocks';

import { manifest, validateManifest } from './manifest.js';

describe('block.manifest.json', () => {
  it('declares the 7 required scopes (no block:settings:*)', () => {
    expect(manifest.scopes).toEqual([
      'collections:read:self',
      'collections:read:private',
      'collections:write:self',
      'social:tip:self',
      'buzz:read:self',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
    ]);
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

  it('is version 0.1.8', () => {
    expect(manifest.version).toBe('0.1.8');
  });
});
