// An in-memory stand-in for the REST families this app reaches: the Buzz
// balance and the document store (the private `kv` collection behind the browse
// prefs, and the `popular_plays` tallies). Used by the dev harness
// (`main.tsx`) and by the tests.
//
// 🔴 WHY THIS IS A `fetch` FAKE AND NOT A MOCK HOST. These are HTTP, not
// postMessage conversations, so a transport-level fake would "answer a
// conversation nobody is having" — the suite would pass while exercising none of
// the code that carries the traffic. The app's real boundary is `fetch`.
//
// 🔴 THE LEGACY STORES ARE DELIBERATELY ABSENT. Until 0.3.0 this fake also
// answered `blocks/app-storage/*` and `blocks/shared-storage/*`. Both surfaces
// are being deleted platform-wide and this app no longer calls them, so a call
// to either now falls through to the loud 404 at the bottom — which is what
// makes a regression back onto a legacy route visible in every test that
// renders the app.
//
// 🔴 WHAT IT IS NOT. It is not a second implementation of the platform's policy:
// no scope checks, no trust gates, no rate limits, no moderation. Those are the
// server's and they are NOT re-asserted here, because a fake that reimplemented
// them would drift and start certifying its own behaviour. What it does own is
// the ROUTE SHAPES — path, method, body, reply envelope — and those are taken
// from the route files, named per family below.
//
/** One seeded document-store document. */
export interface RestDocSeed {
  /** The declared collection's name (`kv` private, `popular_plays` shared). */
  collection: string;
  /** The document's key (for `popular_plays`, a collection id as a string). */
  key: string;
  /**
   * The document's data. Omit for a counter-created document (`{}`, author
   * kind `counter`); give it for a viewer-written one (author kind `user`) —
   * e.g. a `kv` record `{ value: … }`, the copy script's shape.
   */
  data?: Record<string, unknown>;
  /** Counter tallies the document carries, by counter name. */
  counters?: Record<string, number>;
  /** Mark name → ids of the viewers holding that mark. The count is the list's length. */
  marks?: Record<string, number[]>;
}

export interface RestFakeOptions {
  /** The signed-in viewer's id — decides whose marks are the viewer's own. */
  viewerUserId?: number;
  /**
   * Document-store seed + kill switch. `disabled` answers every
   * `blocks/storage/*` call with the store's own 503 envelope — how a server
   * with the document store not enabled reads to the app.
   */
  docStore?: { seed?: RestDocSeed[]; disabled?: boolean };
  /**
   * The viewer's per-pool balance. Omit for {@link DEFAULT_BUZZ_BALANCE}; pass
   * `null` to make the balance route REFUSE (403), which is how a missing
   * `buzz:read:self` grant or an anonymous viewer reads.
   */
  buzz?: { blue: number; green: number; yellow: number } | null;
  /**
   * Called for every request this fake receives — including the ones it 404s,
   * so a test can assert that NO request reached a legacy storage route.
   */
  onRequest?: (call: { path: string; method: string; body: Record<string, unknown> }) => void;
}

/**
 * One document-store document: a `popular_plays` tally document (empty data,
 * created by its first increment) or a private `kv` record (data written by
 * PUT). This fake serves ONE viewer, so a private collection needs no
 * per-viewer key space.
 */
interface DocRow {
  key: string;
  data: Record<string, unknown>;
  version: number;
  authorKind: 'counter' | 'user';
  counters: Map<string, number>;
  /** Mark name → the viewer ids holding it. The count is the set's size. */
  marks: Map<string, Set<number>>;
}

/** A fixed instant, so nothing here reads a clock a test cannot control. */
const EPOCH = '2026-01-01T00:00:00.000Z';

/**
 * The balance reported when none is seeded.
 *
 * 🔴 COPIED FROM THE MOCK HOST ON PURPOSE (`@civitai/blocks-react`'s
 * `DEFAULT_BUZZ_BALANCE`), because this fake INHERITS the job of answering tests
 * that never seeded a balance. Defaulting to zeros instead cost a real failure
 * during the port: the analytics case's tip never sent, because the tip modal's
 * soft ceiling is derived from the balance and a zero ceiling refuses every
 * amount — a test failing three steps away from the thing that changed.
 */
const DEFAULT_BUZZ_BALANCE = { blue: 1000, green: 0, yellow: 5000 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a `fetch` that answers the app's REST surface from memory.
 *
 * Anything it does not recognise gets a 404 carrying the path — LOUD on purpose.
 * A fake that answered `{}` to an unknown route would turn a wrong path into a
 * quietly empty screen, which is the failure this whole port is most able to
 * introduce.
 */
export function createRestFake(options: RestFakeOptions = {}): typeof globalThis.fetch {
  const viewerUserId = options.viewerUserId ?? 99;
  const docStores = new Map<string, Map<string, DocRow>>();
  for (const seed of options.docStore?.seed ?? []) {
    let coll = docStores.get(seed.collection);
    if (!coll) {
      coll = new Map();
      docStores.set(seed.collection, coll);
    }
    coll.set(seed.key, {
      key: seed.key,
      data: seed.data ?? {},
      version: 1,
      authorKind: seed.data === undefined ? 'counter' : 'user',
      counters: new Map(Object.entries(seed.counters ?? {})),
      marks: new Map(Object.entries(seed.marks ?? {}).map(([name, ids]) => [name, new Set(ids)])),
    });
  }

  // The wire shape `@civitai/sdk`'s document client validates field by field:
  // `author` is `{ kind: 'counter' }` for a document its first increment
  // created, the viewer's own for a PUT one, and `viewer` carries only the
  // READING viewer's own mark names.
  const projectDoc = (row: DocRow) => ({
    key: row.key,
    data: row.data,
    version: row.version,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    author: row.authorKind === 'counter' ? { kind: 'counter' } : { kind: 'user', isViewer: true },
    counters: Object.fromEntries(row.counters),
    marks: Object.fromEntries([...row.marks].map(([name, ids]) => [name, ids.size])),
    viewer: { marks: [...row.marks].filter(([, ids]) => ids.has(viewerUserId)).map(([name]) => name) },
  });

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://civitai.com');
    const path = url.pathname.replace(/^.*\/api\/v1\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Record<string, unknown> =
      init?.body == null ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    options.onRequest?.({ path, method, body });

    // --- the balance: GET blocks/buzz → a BARE { blue, green, yellow } ---------
    if (path === 'blocks/buzz') {
      if (options.buzz === null) return json({ error: 'Forbidden' }, 403);
      return json(options.buzz ?? DEFAULT_BUZZ_BALANCE);
    }

    // --- document store: blocks/storage/* --------------------------------------
    // Shapes from the storage guide's REST reference. Refusals use the store's
    // one envelope (`{ code, message, error }`), because the SDK client branches
    // on `code` — a bare `{ error }` here would exercise a different failure
    // class than the server ever produces. Policy (scopes, trust, moderation,
    // quotas) stays the server's, per this file's charter; what is modelled is
    // the tally behaviour the routes themselves define: an increment creates a
    // missing document, a mark needs one to exist, and a mark tally counts
    // DISTINCT viewers because a viewer's second mark changes nothing.
    if (path.startsWith('blocks/storage')) {
      if (options.docStore?.disabled) {
        return json(
          { code: 'storage_disabled', message: 'storage is disabled', error: 'storage is disabled' },
          503,
        );
      }
      const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
      // seg: ['blocks', 'storage', collection, key?, 'counters'|'marks', name?]
      const collection = seg[2];
      let coll = collection === undefined ? undefined : docStores.get(collection);
      const docNotFound = () =>
        json({ code: 'not_found', message: 'document not found', error: 'document not found' }, 404);

      if (collection !== undefined && seg.length === 3 && method === 'GET') {
        // list — one page; `nextCursor` is the next offset as a string, or null.
        const sort = url.searchParams.get('sort') ?? 'key';
        const desc = sort.startsWith('-');
        const field = desc ? sort.slice(1) : sort;
        const tally = /^(counter|mark):(.+)$/.exec(field);
        const tallyOf = (row: DocRow): number =>
          tally === null
            ? 0
            : tally[1] === 'counter'
              ? (row.counters.get(tally[2]) ?? 0)
              : (row.marks.get(tally[2])?.size ?? 0);
        const all = [...(coll?.values() ?? [])].sort((a, b) => {
          const cmp = tally !== null ? tallyOf(a) - tallyOf(b) : a.key.localeCompare(b.key);
          return desc ? -cmp : cmp;
        });
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw === null ? all.length : Number(limitRaw);
        const offset = Number(url.searchParams.get('cursor') ?? 0) || 0;
        const page = all.slice(offset, offset + limit);
        return json({
          items: page.map(projectDoc),
          nextCursor: offset + page.length < all.length ? String(offset + page.length) : null,
        });
      }

      if (collection !== undefined && seg.length === 4 && method === 'GET') {
        const row = coll?.get(seg[3] as string);
        return row ? json(projectDoc(row)) : docNotFound();
      }

      if (collection !== undefined && seg.length === 4 && method === 'PUT') {
        // Upsert: create at version 1, replace and bump the version after.
        if (!coll) {
          coll = new Map();
          docStores.set(collection, coll);
        }
        const key = seg[3] as string;
        const data = (body.data ?? {}) as Record<string, unknown>;
        const prev = coll.get(key);
        const row: DocRow = prev
          ? { ...prev, data, version: prev.version + 1 }
          : { key, data, version: 1, authorKind: 'user', counters: new Map(), marks: new Map() };
        coll.set(key, row);
        return json(projectDoc(row));
      }

      if (collection !== undefined && seg.length === 6 && seg[4] === 'counters' && method === 'POST') {
        if (!coll) {
          coll = new Map();
          docStores.set(collection, coll);
        }
        const key = seg[3] as string;
        let row = coll.get(key);
        if (!row) {
          // The first increment of a missing key creates the document — the
          // ONLY creation a `write: "none"` collection has.
          row = { key, data: {}, version: 1, authorKind: 'counter', counters: new Map(), marks: new Map() };
          coll.set(key, row);
        }
        const by = typeof body.by === 'number' ? body.by : 1;
        const value = (row.counters.get(seg[5] as string) ?? 0) + by;
        row.counters.set(seg[5] as string, value);
        return json({ value });
      }

      if (collection !== undefined && seg.length === 6 && seg[4] === 'marks' && (method === 'PUT' || method === 'DELETE')) {
        const row = coll?.get(seg[3] as string);
        // A mark on a document that does not exist is a `not_found`, not a
        // creation — measured against the SDK's own fake store.
        if (!row) return docNotFound();
        const name = seg[5] as string;
        let holders = row.marks.get(name);
        if (!holders) {
          holders = new Set();
          row.marks.set(name, holders);
        }
        if (method === 'PUT') holders.add(viewerUserId);
        else holders.delete(viewerUserId);
        return json({ marked: method === 'PUT', count: holders.size });
      }
    }

    return json({ error: `dev-rest: no route for ${method} ${path}` }, 404);
  }) as typeof globalThis.fetch;
}
