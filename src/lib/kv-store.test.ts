// The private `kv` mapping is a contract with the cutover copy script
// (`copy-kv-to-appdata.sql`): collection `kv`, key = the legacy key verbatim,
// data = `{ value: <legacy value> }`. These cases pin all three with LITERALS,
// against the SDK's own fake store built from the COMMITTED manifest — so an
// undeclared or renamed collection fails here as `collection_not_declared`
// rather than passing against a phantom store.

import { describe, expect, it } from 'vitest';

import { createFakeStorage } from '@civitai/sdk/testing';

import { manifest } from '../manifest.js';
import { BROWSE_PREFS_KEY } from './browse-prefs.js';
import { KV_COLLECTION, createKvStore } from './kv-store.js';

function makeFake(viewer: { username: string } | null = { username: 'alice' }) {
  return createFakeStorage({
    manifest: { scopes: manifest.scopes as string[], storage: manifest.storage },
    viewer,
  });
}

describe('createKvStore — the copy-script contract', () => {
  it('names the collection, key and wrapping the copy writes, literally', () => {
    expect(KV_COLLECTION).toBe('kv');
    // The legacy key the one production row sits under; renaming it strands it.
    expect(BROWSE_PREFS_KEY).toBe('playable-collections:browse-prefs');
  });

  it('reads a record exactly as the copy script lays it down', async () => {
    const fake = makeFake();
    // What `copy-kv-to-appdata.sql` writes: the legacy value wrapped in `value`.
    await fake.storage
      .collection('kv')
      .put('playable-collections:browse-prefs', { value: { sort: 'newest', period: 'year' } });

    const kv = createKvStore(() => fake.storage);
    expect(await kv.get('playable-collections:browse-prefs')).toEqual({ sort: 'newest', period: 'year' });
  });

  it('writes the wrapped shape, so a later copy re-run and this app agree', async () => {
    const fake = makeFake();
    const kv = createKvStore(() => fake.storage);
    await kv.set('playable-collections:browse-prefs', { sort: 'popular', period: 'month' });

    const doc = await fake.storage.collection('kv').get('playable-collections:browse-prefs');
    expect(doc?.data).toEqual({ value: { sort: 'popular', period: 'month' } });
  });

  it('answers null for a key never written (not an error)', async () => {
    const kv = createKvStore(() => makeFake().storage);
    expect(await kv.get('playable-collections:browse-prefs')).toBeNull();
  });

  it('is private: one viewer never reads another viewer’s record', async () => {
    const fake = makeFake();
    await createKvStore(() => fake.storage).set(BROWSE_PREFS_KEY, { sort: 'newest', period: 'day' });
    const bob = createKvStore(() => fake.as({ viewer: { username: 'bob' } }).storage);
    expect(await bob.get(BROWSE_PREFS_KEY)).toBeNull();
  });

  it('REJECTS an anonymous viewer rather than reporting "nothing stored"', async () => {
    const kv = createKvStore(() => makeFake(null).storage);
    await expect(kv.get(BROWSE_PREFS_KEY)).rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(kv.set(BROWSE_PREFS_KEY, { sort: 'newest', period: 'day' })).rejects.toMatchObject({
      code: 'sign_in_required',
    });
  });
});
