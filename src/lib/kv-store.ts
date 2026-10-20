// The viewer's private key/value records, over ONE private collection of the
// App Blocks document store.
//
// Until 0.3.0 the browse preferences lived in the legacy per-viewer KV
// (`app.storage.get/set`, `/api/v1/blocks/app-storage/*`, scopes
// `apps:storage:read` + `apps:storage:write`). That store is being deleted
// platform-wide; the document store (`app.storage.collection(name)`, scope
// `apps:storage`) replaces it. This module is the whole port for that half:
// `lib/browse-prefs.ts` keeps the `get`/`set` shape it was written against and
// only this file knows documents exist.
//
// 🔴 THE MAPPING IS FIXED, AND SOMETHING OUTSIDE THIS REPO DEPENDS ON IT EXACTLY.
// Existing viewers' records are copied from the legacy KV into the document
// store by a separate, hand-run script at cutover (the same one the other
// first-party apps used). That script writes what this module reads, so
// changing any of the three rules below strands every copied record:
//
//   1. ONE collection, named `kv`, declared `private` in `block.manifest.json`.
//   2. Document key = the legacy KV key, byte-for-byte
//      (`playable-collections:browse-prefs`).
//   3. Document data = `{ value: <the legacy value> }` — ALWAYS wrapped. A
//      document's data must be an object; the legacy value happens to be one
//      here, but the copy script wraps every value without looking at it, so
//      this module must unwrap every value the same way.
//
// `src/lib/kv-store.test.ts` pins all three with literal values against
// `createFakeStorage` (the SDK's own client over an in-memory server that
// enforces the committed manifest).

import type { DocumentStorage, StorageCollection } from '@civitai/sdk';

/** The one private collection. Must match `block.manifest.json` → `storage.collections`. */
export const KV_COLLECTION = 'kv';

/** The stored document's data. See rule 3 above. */
export interface KvDocument {
  value: unknown;
}

/** The key/value surface this app consumes. */
export interface KvStore {
  /** The stored value, or `null` when the key has never been written. */
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<{ ok: true }>;
}

/**
 * Build the KV surface over a document store.
 *
 * Every failure REJECTS with the store's `StorageError` — an anonymous viewer
 * (`sign_in_required`), a version whose manifest is not yet approved
 * (`collection_not_declared`), a quota or rate limit. Nothing here turns a
 * refusal into "nothing stored", because `useBrowsePrefs` must tell the two
 * apart: it never writes over a record it could not read.
 *
 * `docs` is called per operation rather than once, so the production caller can
 * hand in "await the AppClient" and the façade stays a stable object that exists
 * before the handshake lands.
 */
export function createKvStore(docs: () => DocumentStorage | Promise<DocumentStorage>): KvStore {
  const kv = async (): Promise<StorageCollection<KvDocument>> =>
    (await docs()).collection<KvDocument>(KV_COLLECTION);

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const doc = await (await kv()).get(key);
      // A missing document is `null`, as the legacy `get` answered for a key
      // never written. Data without `value` reads as missing too.
      return (doc?.data.value ?? null) as T | null;
    },
    async set<T = unknown>(key: string, value: T): Promise<{ ok: true }> {
      await (await kv()).put(key, { value });
      return { ok: true };
    },
  };
}
