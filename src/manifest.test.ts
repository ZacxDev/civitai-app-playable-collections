import { describe, expect, it } from 'vitest';

import { defineBlock } from '@civitai/app-sdk/blocks';

import { KNOWN_INCOMING_SCOPES, manifest, validateManifest } from './manifest.js';

describe('block.manifest.json', () => {
  it('declares the 8 required scopes', () => {
    expect(manifest.scopes).toEqual([
      'collections:read:self',
      'collections:write:self',
      'social:tip:self',
      'buzz:read:self',
      'block:settings:read',
      'block:settings:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
    ]);
  });

  it('is a page app at "/" with the right settings keys', () => {
    expect((manifest.page as { path: string }).path).toBe('/');
    const settings = manifest.settings as Record<string, { scope: string; min?: number; max?: number; default?: number }>;
    expect(settings.seconds_per_image).toMatchObject({ scope: 'viewer', min: 1, max: 60, default: 5 });
    expect(settings.video_loop_count).toMatchObject({ scope: 'viewer', min: 1, max: 10, default: 1 });
  });

  it('passes defineBlock once augmented + known-incoming scopes exempted', () => {
    expect(() => validateManifest()).not.toThrow();
    const validated = validateManifest();
    // The 4-segment shared-storage scopes are stripped for the published
    // validator (TODO(wave2)); the 3-segment collections scopes remain.
    expect(validated.scopes).toContain('collections:read:self');
    expect(validated.scopes).not.toContain('apps:storage:shared:read');
  });

  it('confirms the published defineBlock still rejects the 4-segment scope (why the exemption exists)', () => {
    // Guard the assumption behind KNOWN_INCOMING_SCOPES: if a future SDK accepts
    // 4-segment scopes, this test flips and we can delete the exemption.
    expect(() =>
      defineBlock({
        manifest: {
          $schema: 'https://civitai.com/schemas/app-block/v1.json',
          appId: 'app_x',
          blockId: 'x-block',
          version: '0.1.0',
          name: 'X',
          type: 'block',
          targets: [{ slotId: 'app.page', priority: 100 }],
          scopes: ['apps:storage:shared:read'],
          iframe: { src: 'https://x.civit.ai/', minHeight: 100, resizable: true, sandbox: 'allow-scripts' },
          contentRating: 'g',
          minApiVersion: '1.0',
        },
      }),
    ).toThrow();
    expect(KNOWN_INCOMING_SCOPES).toContain('apps:storage:shared:read');
  });

  it('throws if a known-incoming scope is missing from the manifest', () => {
    const bad = { ...manifest, scopes: ['collections:read:self'] };
    expect(() => validateManifest(bad)).toThrow(/known-incoming scope/);
  });
});
