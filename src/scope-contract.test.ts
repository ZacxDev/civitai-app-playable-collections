// ---------------------------------------------------------------------------
// 🔴 THE SCOPE CONTRACT — what the CODE calls vs what the MANIFEST declares
// ---------------------------------------------------------------------------
//
// `manifest.test.ts` pins the declared scope list against a LITERAL. That is a
// claim about the manifest and nothing else, and it is exactly why it stayed
// green over a build whose every persistence call was refused by the host: the
// code had started calling `useAppStorage()` — the PER-VIEWER app store, which
// needs `apps:storage:read` / `apps:storage:write` — while the manifest declared
// only the cross-user `apps:storage:shared:*` pair. The host compares the
// required scope against the token's scope set by EXACT STRING MATCH, so
// `apps:storage:shared:read` does not satisfy `apps:storage:read`. Both call
// sites swallowed the rejection, so the feature was inert with no error, no log
// and no metric, and 700+ passing tests could not express it (the mock host
// answers the storage bridge unconditionally and never inspects manifest scopes).
//
// This file pins the RELATIONSHIP instead, and fails in BOTH directions:
//
//   1. A scoped SDK hook is called in `src/` whose scope the manifest does NOT
//      declare  ->  a silently broken feature. (The bug above.)
//   2. A scope is declared in the manifest that NOTHING in `src/` consumes  ->
//      a capability disclosed to a moderator and to every viewer for nothing.
//
// 🔴 WHAT IT CANNOT DO, STATED UP FRONT: this is a check on the DECLARATION, not
// on production behaviour. Nothing here (and nothing anywhere in this suite)
// proves the host accepts the scopes, because the mock host does not implement
// the scope gate. Only a signed-in reload against the live host can settle that.
//
// ---------------------------------------------------------------------------
// 🔴 WHY THE HOOK -> SCOPE MAP IS WRITTEN DOWN HERE AND NOT DERIVED
// ---------------------------------------------------------------------------
// The SCOPE VOCABULARY is derived — every scope below is a reference into the
// SDK's own `BLOCK_SCOPES`, so a renamed or retired scope string is a type error
// here rather than a literal that quietly stops matching.
//
// The HOOK -> SCOPE mapping is not derivable: `@civitai/blocks-react` ships no
// machine-readable scope metadata, and its JSDoc names a scope for only some
// hooks. Measured against the installed `0.49.0`: `useTip`, `useTipAllowance`,
// `useBuzzTransactions`, `useBuzzAccounts`, `useDailyCompensation`,
// `useAppWorkflows` and `useSharedStorage` each name theirs; `useAppStorage` —
// the hook this whole file exists because of — names NONE. So a map derived from
// the docs would have been blind to precisely the defect it is here to catch.
//
// It is therefore hand-written, and its STALENESS IS ITSELF CHECKED:
//   - every `use*` export of `@civitai/blocks-react` must appear in exactly one
//     of the three buckets below, so a hook added by an SDK bump fails this file
//     by name instead of arriving unclassified;
//   - every value in the SDK's `BLOCK_SCOPES` must be accounted for in one of the
//     ledgers, so a scope added by an SDK bump does the same;
//   - a hook whose scope could NOT be established from the installed package sits
//     in `HOOK_SCOPE_UNVERIFIED`, which FAILS CLOSED: calling one from `src/` is
//     an error telling the author to establish its scope first, rather than a
//     guess that reads as knowledge.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BLOCK_SCOPES, type BlockScope } from '@civitai/app-sdk/blocks';

import { manifest } from './manifest.js';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// Ledger 1 — hooks that REQUIRE a manifest scope
// ---------------------------------------------------------------------------
/**
 * `@civitai/blocks-react` hook -> the manifest scopes it needs.
 *
 * Hook-level, not method-level: `useAppStorage` exposes both reads and writes,
 * so a caller that only ever reads would over-declare `apps:storage:write` by
 * this ledger's reckoning. That coarseness is deliberate — a static check cannot
 * tell which methods a caller reaches — and it is recorded here rather than left
 * for a reader to discover.
 *
 * Each entry cites the evidence it rests on. "d.ts" means the installed
 * package's own JSDoc names that scope for that hook.
 */
const HOOK_REQUIRED_SCOPES: Readonly<Record<string, readonly BlockScope[]>> = {
  // 🔴 NO d.ts EVIDENCE — `useAppStorage`'s typings name no scope at all. The
  // mapping rests on (a) the host refusing the call without these, measured on
  // the live app, and (b) `BLOCK_SCOPES`' own comment on the pair: "apps:storage:*
  // — the per-app KV datastore (W4) … the server gates them by presence in the
  // block's approved scope set". This is the entry the whole file exists for.
  useAppStorage: [BLOCK_SCOPES.APPS_STORAGE_READ, BLOCK_SCOPES.APPS_STORAGE_WRITE],
  // d.ts: "Gated by the same `apps:storage:shared:write` scope as `append`".
  // The list/get side is the matching shared READ.
  useSharedStorage: [BLOCK_SCOPES.APPS_STORAGE_SHARED_READ, BLOCK_SCOPES.APPS_STORAGE_SHARED_WRITE],
  // d.ts: "the block-token-gated `POST /api/v1/blocks/tip` REST endpoint (scope
  // `social:tip:self`)".
  useTip: [BLOCK_SCOPES.SOCIAL_TIP_SELF],
  // d.ts: "(scope `social:tip:self` — the SAME scope the app already holds to
  // tip, so no manifest change)".
  useTipAllowance: [BLOCK_SCOPES.SOCIAL_TIP_SELF],
  // d.ts names `buzz:read:self` as the scope whose absence is an error; `scopes.ts`
  // in this repo records the same thing from the live app (civitai/civitai#4745).
  useBuzzBalance: [BLOCK_SCOPES.BUZZ_READ_SELF],
  // d.ts: "reads via its `blocks.getMyBuzzTransactions` mutation (scope `buzz:read:self`)".
  useBuzzTransactions: [BLOCK_SCOPES.BUZZ_READ_SELF],
  // d.ts: "reads via its `blocks.getMyBuzzAccounts` mutation (scope `buzz:read:self`)".
  useBuzzAccounts: [BLOCK_SCOPES.BUZZ_READ_SELF],
  // d.ts: "reads via its `blocks.getMyDailyCompensation` mutation (scope `buzz:read:self`)".
  useDailyCompensation: [BLOCK_SCOPES.BUZZ_READ_SELF],
  // d.ts: "FORCES the per-app tag filter (scope `ai:write:budgeted`, same trust
  // boundary as submit)".
  useAppWorkflows: [BLOCK_SCOPES.AI_WRITE_BUDGETED],
} as const;

// ---------------------------------------------------------------------------
// Ledger 2 — hooks that need NO manifest scope
// ---------------------------------------------------------------------------
/**
 * Transport, chrome, layout and host-mediated hooks: none of them reads or
 * writes a viewer resource off the block token, so none costs a declaration.
 *
 * Most of this list is settled by this app itself: it calls `useBlockContext`,
 * `useBlockResize`, `useBlockToken`, `useHostOrigin`, `useRequestConsent`,
 * `useRequestSignIn` and `useDomainMaturity` in production today while declaring
 * none of the scopes above for them.
 */
const UNSCOPED_HOOKS: readonly string[] = [
  'useBlockAnalytics',
  'useBlockBreakpoint',
  'useBlockContext',
  'useBlockResize',
  'useBlockTheme',
  'useBlockToken',
  'useCivitaiNavigate',
  // d.ts: "EVERY CALL OPENS A HOST-CHROME CONSENT CONFIRM … What it costs is the
  // manifest `scopes` declaration a moderator reads before install." This repo
  // dropped `collections:write:self` in 0.2.10 for exactly that move — see the
  // ledger comment in `manifest.test.ts`.
  'useCollectionFollow',
  'useConsentUnavailable',
  'useDirectLoad',
  'useDomainMaturity',
  'useHostOrigin',
  'useRequestConsent',
  'useRequestSignIn',
  // d.ts: "TOKEN-INDEPENDENT (no block scope)".
  'useWildcardPack',
];

// ---------------------------------------------------------------------------
// Ledger 3 — hooks whose scope could NOT be established. FAILS CLOSED.
// ---------------------------------------------------------------------------
/**
 * The installed package names no scope for these and this app calls none of
 * them, so there is nothing to derive a mapping from and no in-repo behaviour to
 * settle it. Guessing here would read as knowledge, so instead: calling one of
 * these from `src/` FAILS this file, with instructions to establish its scope
 * (and move it into ledger 1 or 2) first.
 *
 * `useBlockSettings` is in here for a different reason worth stating: the scope
 * it would need (`block:settings:read`/`:write`) is not a member of the SDK's
 * `BLOCK_SCOPES` at all, and this page app deliberately declares no manifest
 * `settings` block — see `manifest.test.ts`.
 */
const HOOK_SCOPE_UNVERIFIED: readonly string[] = [
  'useBlockSettings',
  'useBuzzPurchase',
  'useBuzzWorkflow',
  'useCheckpointPicker',
  'useGatedImages',
  'useGenerationResources',
  'useImageUpload',
  'usePublishGenerationOutputs',
  'useResourcePicker',
  'useSaveImage',
  'useViewer',
];

// ---------------------------------------------------------------------------
// Ledger 4 — scopes this app consumes WITHOUT a hook
// ---------------------------------------------------------------------------
/**
 * Not every scope is reached through a hook. The collection reads and the tip
 * POST are direct block-token-authed REST calls out of `lib/api.ts`, so
 * direction 2 would falsely flag them as undeclared-for-nothing if hooks were
 * the only consumer it knew about.
 *
 * `token` is a string that must appear VERBATIM in `file`, and `file` must be a
 * non-test source file the scanner actually sees. So an entry cannot survive the
 * code it claims to describe being deleted.
 */
const NON_HOOK_SCOPE_CONSUMERS: Readonly<
  Partial<Record<BlockScope, { file: string; token: string; why: string }>>
> = {
  [BLOCK_SCOPES.COLLECTIONS_READ_SELF]: {
    file: 'lib/api.ts',
    token: "'/api/v1/blocks/collections'",
    why: 'The public + own-public collection feed the whole app browses.',
  },
  [BLOCK_SCOPES.COLLECTIONS_READ_PRIVATE]: {
    file: 'scopes.ts',
    token: "COLLECTIONS_READ_PRIVATE = 'collections:read:private'",
    why: "Consent-gated widening of the same feed to the viewer's own private collections; `App.tsx` branches on whether the token carries it.",
  },
  [BLOCK_SCOPES.SOCIAL_TIP_SELF]: {
    file: 'lib/api.ts',
    token: "tip: '/api/v1/blocks/tip'",
    why: 'The tip POST. This app posts it directly rather than through `useTip`.',
  },
};

/** SDK scopes this app has no consumer for, by design. */
const SCOPES_NOT_USED_BY_THIS_APP: readonly BlockScope[] = [
  BLOCK_SCOPES.MODELS_READ_SELF,
  BLOCK_SCOPES.USER_READ_SELF,
  // Dropped in 0.2.10 when following moved to the host-mediated consent bridge.
  BLOCK_SCOPES.COLLECTIONS_WRITE_SELF,
];

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/** Every non-test `.ts`/`.tsx` under `src/`, relative to `src/`. */
function sourceFiles(dir = SRC_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full, `${prefix}${entry}/`));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(`${prefix}${entry}`);
  }
  return out.sort();
}

/**
 * Which `@civitai/blocks-react` names each non-test source file imports AS
 * VALUES — `import type` statements and inline `type` specifiers are excluded,
 * because a type reference reaches no host bridge and costs no scope.
 * (`lib/popular.ts` imports `UseSharedStorage` exactly that way.)
 *
 * 🔴 AN IMPORT IS TREATED AS A CALL, and that is sound HERE rather than in
 * general: `tsconfig.json` sets `noUnusedLocals: true`, so a value import that
 * is never referenced is a typecheck failure in this repo, and `pnpm build` runs
 * `tsc --noEmit` before vite. An imported hook is therefore a used hook.
 */
function scanValueImports(): Map<string, string[]> {
  const byHook = new Map<string, string[]>();
  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'@civitai\/blocks-react'/g;
  for (const rel of sourceFiles()) {
    const text = readFileSync(join(SRC_DIR, rel), 'utf8');
    for (const match of text.matchAll(importRe)) {
      if (match[1]) continue; // `import type { … }` — no runtime call.
      for (const raw of match[2].split(',')) {
        const spec = raw.trim();
        if (!spec || /^type\s/.test(spec)) continue; // inline `type X` specifier.
        const name = (spec.split(/\s+as\s+/)[0] ?? '').trim();
        if (!name) continue;
        byHook.set(name, [...(byHook.get(name) ?? []), rel]);
      }
    }
  }
  return byHook;
}

/** The contents of a non-test source file, by its `src/`-relative path. */
function readSource(rel: string): string {
  return readFileSync(join(SRC_DIR, rel), 'utf8');
}

const declaredScopes = manifest.scopes as BlockScope[];
const imported = scanValueImports();

// ---------------------------------------------------------------------------
// 🔴 The scanner's own controls. A check built on a scanner wired to nothing
// returns a confident, meaningless PASS in both directions — so prove it can
// see a hook that IS there and does not invent one that is not, before reading
// any verdict below.
// ---------------------------------------------------------------------------
describe('the scanner itself', () => {
  it('reads a non-trivial number of source files', () => {
    expect(sourceFiles().length).toBeGreaterThan(30);
  });

  it('POSITIVE CONTROL — finds the scoped hook this app really does call', () => {
    // If this goes empty, every "no undeclared scope" verdict below is vacuous.
    expect(imported.get('useAppStorage')).toContain('App.tsx');
    expect(imported.get('useSharedStorage')).toContain('App.tsx');
    expect(imported.get('useBuzzBalance')).toContain('App.tsx');
  });

  it('NEGATIVE CONTROL — does not report a hook this app does not import', () => {
    // `useTip` exists in the SDK and is deliberately not used here (the tip is a
    // direct REST POST). A scanner that matched on any mention would find it in
    // prose and comments.
    expect(imported.has('useTip')).toBe(false);
    expect(imported.has('useTipAllowance')).toBe(false);
  });

  it('NEGATIVE CONTROL — a TYPE-only import is not a call', () => {
    // `lib/popular.ts` imports `UseSharedStorage`, `SharedListItem` and
    // `SharedAppendValue` as types. None reaches a host bridge.
    expect(readSource('lib/popular.ts')).toContain("import type {");
    expect(imported.has('UseSharedStorage')).toBe(false);
    expect(imported.has('SharedListItem')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Direction 1 — the code calls it, the manifest had better declare it
// ---------------------------------------------------------------------------
describe('🔴 every scoped SDK hook called in src/ has its scope DECLARED', () => {
  it('declares a scope for each scoped hook the app imports', () => {
    const missing: string[] = [];
    for (const [hook, files] of imported) {
      const required = HOOK_REQUIRED_SCOPES[hook];
      if (!required) continue;
      for (const scope of required) {
        if (!declaredScopes.includes(scope)) {
          missing.push(`${hook} (${files.join(', ')}) needs "${scope}"`);
        }
      }
    }
    // Named, not counted: the failure message is the fix instruction.
    expect(missing).toEqual([]);
  });

  it('refuses a hook whose required scope was never established', () => {
    const unverified = [...imported.keys()].filter((h) => HOOK_SCOPE_UNVERIFIED.includes(h));
    // Fails CLOSED. Establish the scope from the installed package or the host,
    // then move the hook into HOOK_REQUIRED_SCOPES or UNSCOPED_HOOKS.
    expect(unverified).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direction 2 — the manifest declares it, something had better want it
// ---------------------------------------------------------------------------
describe('🔴 every scope DECLARED in the manifest has a live consumer in src/', () => {
  it('has a hook caller or a registered non-hook consumer for each declared scope', () => {
    const calledHookScopes = new Set<string>();
    for (const hook of imported.keys()) {
      for (const scope of HOOK_REQUIRED_SCOPES[hook] ?? []) calledHookScopes.add(scope);
    }

    const orphans: string[] = [];
    for (const scope of declaredScopes) {
      if (calledHookScopes.has(scope)) continue;
      const consumer = NON_HOOK_SCOPE_CONSUMERS[scope];
      if (consumer && readSource(consumer.file).includes(consumer.token)) continue;
      orphans.push(scope);
    }
    // A scope with no consumer is a capability shown to a moderator and to every
    // viewer for nothing. Drop it from the manifest, or register its consumer.
    expect(orphans).toEqual([]);
  });

  it('keeps every registered non-hook consumer honest against the real source', () => {
    // The evidence token must actually be in the file it names — so the ledger
    // cannot outlive the code it describes.
    for (const [scope, consumer] of Object.entries(NON_HOOK_SCOPE_CONSUMERS)) {
      expect(sourceFiles(), `${scope}: ${consumer!.file} is not a scanned source file`).toContain(
        consumer!.file,
      );
      expect(readSource(consumer!.file), `${scope}: token missing from ${consumer!.file}`).toContain(
        consumer!.token,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The ledgers' own staleness
// ---------------------------------------------------------------------------
describe('the ledgers cannot silently go stale under an SDK bump', () => {
  it('classifies EVERY use* export of @civitai/blocks-react exactly once', async () => {
    const mod = await import('@civitai/blocks-react');
    const exported = Object.keys(mod)
      .filter((k) => /^use[A-Z]/.test(k))
      .sort();
    expect(exported.length).toBeGreaterThan(20); // positive control on the enumeration

    const unclassified: string[] = [];
    const doubleClassified: string[] = [];
    for (const hook of exported) {
      const buckets = [
        hook in HOOK_REQUIRED_SCOPES,
        UNSCOPED_HOOKS.includes(hook),
        HOOK_SCOPE_UNVERIFIED.includes(hook),
      ].filter(Boolean).length;
      if (buckets === 0) unclassified.push(hook);
      if (buckets > 1) doubleClassified.push(hook);
    }
    // A hook added by an SDK bump lands here by NAME, rather than arriving
    // unclassified and being silently exempt from direction 1.
    expect(unclassified).toEqual([]);
    expect(doubleClassified).toEqual([]);
  });

  it('names no hook the SDK does not actually export', async () => {
    const mod = await import('@civitai/blocks-react');
    const exported = new Set(Object.keys(mod));
    const ghosts = [
      ...Object.keys(HOOK_REQUIRED_SCOPES),
      ...UNSCOPED_HOOKS,
      ...HOOK_SCOPE_UNVERIFIED,
    ].filter((h) => !exported.has(h));
    // The other rot direction: a hook removed by an SDK bump leaves a ledger
    // entry that looks like coverage and covers nothing.
    expect(ghosts).toEqual([]);
  });

  it('accounts for EVERY scope in the SDK vocabulary', () => {
    const accountedFor = new Set<string>([
      ...Object.values(HOOK_REQUIRED_SCOPES).flat(),
      ...Object.keys(NON_HOOK_SCOPE_CONSUMERS),
      ...SCOPES_NOT_USED_BY_THIS_APP,
    ]);
    const unaccounted = Object.values(BLOCK_SCOPES).filter((s) => !accountedFor.has(s));
    // A scope added by an SDK bump has to be placed deliberately.
    expect(unaccounted).toEqual([]);
  });

  it('names no scope outside the SDK vocabulary, in any ledger or in the manifest', () => {
    const known = new Set<string>(Object.values(BLOCK_SCOPES));
    for (const scope of [
      ...Object.values(HOOK_REQUIRED_SCOPES).flat(),
      ...Object.keys(NON_HOOK_SCOPE_CONSUMERS),
      ...SCOPES_NOT_USED_BY_THIS_APP,
      ...declaredScopes,
    ]) {
      expect(known.has(scope), `"${scope}" is not a known block scope`).toBe(true);
    }
  });
});
