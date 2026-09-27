// An in-memory stand-in for the three REST families this app reaches after the
// port: per-viewer app storage, cross-user shared storage, and the Buzz balance.
// Used by the dev harness (`main.tsx`) and by the tests that used to seed those
// stores through the mock host.
//
// 🔴 WHY THIS IS A `fetch` FAKE AND NOT A MOCK HOST, which is the whole point.
// Before the port, `useAppStorage`/`useSharedStorage`/`useBuzzBalance` were
// postMessage conversations and `@civitai/blocks-react/testing`'s mock host
// answered them. After it, they are HTTP. A transport-level fake would therefore
// "answer a conversation nobody is having" — the suite would pass while
// exercising none of the code that now carries the traffic. The app's real
// boundary for these three is `fetch`, so the fake belongs there.
//
// 🔴 WHAT IT IS NOT. It is not a second implementation of the platform's policy:
// no scope checks, no trust gates, no rate limits, no moderation. Those are the
// server's and they are NOT re-asserted here, because a fake that reimplemented
// them would drift and start certifying its own behaviour. What it does own is
// the ROUTE SHAPES — path, method, body, reply envelope — and those are taken
// from the route files, named per family below.
//
// 🔴 KEYS ARE ULID-SHAPED, NOT `shared_<n>`. The real server GENERATES a ULID
// (`apps-shared.router.ts`), and this repo has already been bitten once by an
// e2e case that targeted the retired mock host's `shared_2` minting convention —
// a test asserting a fake's implementation detail rather than the platform's
// contract. A seed may pin its own key; otherwise the mint is ULID-shaped, and
// deliberately DETERMINISTIC so a test can predict it without a clock.

/** One seeded shared row. Mirrors the mock host's `MockSharedSeed`. */
export interface RestSharedSeed {
  value: unknown;
  /** Defaults to the configured viewer, i.e. "the viewer wrote this". */
  authorUserId?: number;
  /** Viewer ids holding an up-vote. The row's `count` is this list's length. */
  voters?: number[];
  /** Pin the row's key instead of minting one. */
  key?: string;
}

export interface RestFakeOptions {
  /** The signed-in viewer's id — decides `viewerVoted` and default authorship. */
  viewerUserId?: number;
  /** Per-viewer KV seed (key → JSON value). Mirrors `MockStorageScenario.seed`. */
  storage?: { seed?: Record<string, unknown>; limitBytes?: number; limitRows?: number };
  /** Shared-store seed, listed newest-first in the order given. */
  shared?: { seed?: RestSharedSeed[] };
  /**
   * The viewer's per-pool balance. Omit for {@link DEFAULT_BUZZ_BALANCE}; pass
   * `null` to make the balance route REFUSE (403), which is how a missing
   * `buzz:read:self` grant or an anonymous viewer reads.
   */
  buzz?: { blue: number; green: number; yellow: number } | null;
  /**
   * Called for every request this fake answers. The observation seam a test needs
   * now that these three families are HTTP: a guard that used to watch an
   * `APP_STORAGE_SET` postMessage watches the `blocks/app-storage/set` call here.
   */
  onRequest?: (call: { path: string; method: string; body: Record<string, unknown> }) => void;
}

interface SharedRow {
  key: string;
  authorUserId: number;
  value: unknown;
  voters: Set<number>;
  createdAt: string;
  updatedAt: string;
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

/** Crockford base32, the ULID alphabet. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A 26-character ULID-SHAPED key, derived from a counter.
 *
 * Not a real ULID — it is not time-ordered and carries no entropy — and it does
 * not pretend to be. What matters at this seam is that it looks nothing like an
 * index, so a test cannot accidentally hard-code `shared_2` and pass.
 */
function mintKey(n: number): string {
  let rest = n;
  const tail: string[] = [];
  for (let i = 0; i < 26; i += 1) {
    tail.push(CROCKFORD[rest % 32] as string);
    rest = Math.floor(rest / 32) + 7;
  }
  return tail.reverse().join('');
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

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
  const kv = new Map<string, { value: unknown; updatedAt: string }>(
    Object.entries(options.storage?.seed ?? {}).map(([k, v]) => [k, { value: v, updatedAt: EPOCH }]),
  );
  const limitBytes = options.storage?.limitBytes ?? 50 * 1024 * 1024;
  const limitRows = options.storage?.limitRows ?? 1_000_000;

  let minted = 0;
  const rows: SharedRow[] = (options.shared?.seed ?? []).map((seed) => {
    minted += 1;
    return {
      key: seed.key ?? mintKey(minted),
      authorUserId: seed.authorUserId ?? viewerUserId,
      value: seed.value,
      voters: new Set(seed.voters ?? []),
      createdAt: EPOCH,
      updatedAt: EPOCH,
    };
  });

  const project = (row: SharedRow) => ({
    key: row.key,
    authorUserId: row.authorUserId,
    value: row.value,
    count: row.voters.size,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    viewerVoted: row.voters.has(viewerUserId),
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

    // --- per-viewer KV: POST blocks/app-storage/* ------------------------------
    // Shapes from src/pages/api/v1/blocks/app-storage/{get,set,delete,list,quota}.ts
    if (path.startsWith('blocks/app-storage/')) {
      const op = path.slice('blocks/app-storage/'.length);
      const key = String(body.key ?? '');
      if (op === 'get') return json({ value: kv.get(key)?.value ?? null });
      if (op === 'set') {
        const size = bytesOf(body.value);
        kv.set(key, { value: body.value, updatedAt: EPOCH });
        // `{ ok: true, sizeBytes }`, and `sizeBytes` is REQUIRED — the SDK's client
        // throws without it, and the route's docblock says there is "no 2xx path
        // that means not written".
        return json({ ok: true, sizeBytes: size });
      }
      if (op === 'delete') return json({ ok: true, deleted: kv.delete(key) });
      if (op === 'list') {
        const prefix = body.prefix === undefined ? '' : String(body.prefix);
        const keys = [...kv.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({ key: k, updatedAt: v.updatedAt }));
        return json({ keys });
      }
      if (op === 'quota') {
        let usedBytes = 0;
        for (const [, v] of kv) usedBytes += bytesOf(v.value);
        return json({ usedBytes, rowCount: kv.size, limitBytes, limitRows });
      }
    }

    // --- shared store: blocks/shared-storage/* ---------------------------------
    // Shapes from src/pages/api/v1/blocks/shared-storage/*.ts. Reads are GET with
    // a query string, writes are POST with a body — the route table's own split;
    // a read sent as POST is a 405 on the real surface.
    if (path.startsWith('blocks/shared-storage/')) {
      const op = path.slice('blocks/shared-storage/'.length);
      if (op === 'list' && method === 'GET') {
        const limit = url.searchParams.get('limit');
        const page = limit === null ? rows : rows.slice(0, Number(limit));
        // `metadata` is where `nextCursor` lives, and the SDK guards its presence
        // as strictly as `items` — so it is always sent, even when empty.
        return json({ items: page.map(project), metadata: {} });
      }
      if (op === 'item' && method === 'GET') {
        const found = rows.find((r) => r.key === url.searchParams.get('key'));
        return json({ item: found ? project(found) : null });
      }
      if (op === 'append' && method === 'POST') {
        minted += 1;
        const row: SharedRow = {
          key: mintKey(minted),
          authorUserId: viewerUserId,
          value: body.value,
          voters: new Set(),
          createdAt: EPOCH,
          updatedAt: EPOCH,
        };
        // Newest-first, which is the order `list` documents.
        rows.unshift(row);
        return json({ key: row.key });
      }
      if (op === 'update' && method === 'POST') {
        const row = rows.find((r) => r.key === body.key);
        if (!row) return json({ error: 'NOT_FOUND' }, 404);
        row.value = body.value;
        return json({ ok: true });
      }
      if (op === 'withdraw' && method === 'POST') {
        const at = rows.findIndex((r) => r.key === body.key);
        if (at < 0) return json({ deleted: false });
        rows.splice(at, 1);
        return json({ deleted: true });
      }
      if (op === 'vote' && method === 'POST') {
        const row = rows.find((r) => r.key === body.key);
        // The real route pre-checks existence and answers 404 for a missing or
        // hidden row, so it is not an oracle for withdrawn rows.
        if (!row) return json({ error: 'NOT_FOUND' }, 404);
        // 🔴 IDEMPOTENT, because the platform's is: a `Set` reproduces the real
        // route's "atomic insert-gated counter — a double vote is a no-op and the
        // tally never inflates". `recordPlay` votes then re-reads, so a fake that
        // incremented per call would make an inflating count look correct.
        row.voters.add(viewerUserId);
        return json({ count: row.voters.size });
      }
      if (method !== 'GET' && method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
      }
    }

    return json({ error: `dev-rest: no route for ${method} ${path}` }, 404);
  }) as typeof globalThis.fetch;
}
