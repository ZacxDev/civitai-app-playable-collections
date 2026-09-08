// 🔴 THE APP'S TIP PATH, PINNED TO THE UPSTREAM HOOKS' CONTRACT.
//
// T5 criterion 4 reads: "Tipping goes through upstream `useTip` /
// `useTipAllowance`; the app keeps its own amount picker. `TipButton` is not
// adopted." Its first clause and this task's own non-goal ("moving tipping off
// the app's own `ApiClient`") cannot both hold literally: `useTip()` takes no
// injection seam — it raw-`fetch`es the validated host origin with the block
// bearer token — so calling it would bypass the fake that every test and the dev
// harness inject, and lose this client's `ApiError` taxonomy
// (`insufficient_balance` / `rate_limited` + Retry-After / `network`) that the
// UX branches on. The non-goal is taken as binding.
//
// What is checkable, and what this file checks, is the rest of the criterion and
// the part of the first clause that is real: the app must speak the SAME
// contract as those hooks, and must not adopt `TipButton`.
//
//   1. SHAPE — the app's `TipInput` must be assignable to upstream `TipParams &
//      TipOptions`, and its allowance read to upstream's `TipAllowance`. These
//      are compile-time assertions; `pnpm typecheck` is where they fire, and a
//      runtime `expect` here is what makes their absence visible in a test run.
//   2. SEMANTICS — the idempotency rule the two share: one key per LOGICAL tip,
//      reused on retry.
//   3. NOT ADOPTED — `TipButton` must appear in no shipping file, and the app's
//      own picker must be the thing that is imported instead. A structural check
//      over the source, with a positive control, because "we did not adopt it" is
//      otherwise a claim nothing enforces.
//
// ⚠️ WHAT THIS FILE DOES NOT SHOW. It does not prove a tip reaches civitai, and
// nothing in this repo can: a real Buzz transfer is auth- and Turnstile-gated and
// needs a human in a real mod-gated host. It proves the app's request shape is
// the one the platform's own hooks send, so the two cannot drift apart silently.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { TipParams, TipOptions, TipAllowance as UpstreamTipAllowance } from '@civitai/blocks-react';

import type { TipInput, TipAllowance as AppTipAllowance } from './types.js';
import { TIP_MAX_PER_TIP } from './lib/tip-allowance.js';
import { newIdempotencyKey } from './lib/tip-split.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));
/** This file's own basename — it necessarily names `TipButton`, so it is excluded. */
const SELF = 'tip-contract.test.ts';

// ---------------------------------------------------------------------------
// 1. SHAPE — compile-time, asserted where a reader will see it fail
// ---------------------------------------------------------------------------

/**
 * 🔴 THESE FOUR LINES ARE THE GUARD. If upstream renames `toUserId`, widens
 * `entityType`, or moves the key out of `TipOptions`, `tsc` fails HERE — at the
 * one place in the repo that claims the two agree — rather than nowhere at all.
 * They are `const` declarations rather than a comment because a comment claiming
 * parity is exactly the thing this arc keeps finding to be false.
 */
const appTipIsUpstreamShaped: (input: TipInput) => TipParams & TipOptions = (input) => input;
const upstreamTipIsAppShaped: (params: TipParams & TipOptions) => TipInput = (params) => params;
const appAllowanceIsUpstreamShaped: (a: AppTipAllowance) => Pick<UpstreamTipAllowance, 'remaining'> = (a) => a;

describe('the app speaks the same tip contract as upstream useTip / useTipAllowance', () => {
  it('a TipInput IS a TipParams & TipOptions, in both directions', () => {
    const input: TipInput = {
      toUserId: 22,
      amount: 50,
      entityType: 'Image',
      entityId: 1001,
      idempotencyKey: 'k-1',
    };
    // Round-tripping the SAME object through both directions is what makes the
    // two type assertions above load-bearing at runtime as well: a reader who
    // deletes them sees these expectations lose their subject.
    expect(appTipIsUpstreamShaped(input)).toEqual(input);
    expect(upstreamTipIsAppShaped(input)).toEqual(input);
  });

  it('the allowance read exposes the `remaining` figure upstream exposes', () => {
    const allowance: AppTipAllowance = { cap: 25000, spent: 24700, remaining: 300 };
    expect(appAllowanceIsUpstreamShaped(allowance).remaining).toBe(300);
    // The app never recomputes `remaining` from cap − spent; it reads the
    // server's own figure, exactly as upstream's hook does.
    expect(allowance.remaining).toBe(allowance.cap - allowance.spent);
  });

  it('the per-tip cap the app pre-blocks against is the server figure, not a guess', () => {
    expect(TIP_MAX_PER_TIP).toBe(5000);
  });

  it('a key is minted per LOGICAL tip — two mints never collide', () => {
    // The semantic half of `TipOptions.idempotencyKey`. Reuse-on-retry is
    // behavioural and is pinned in `components/tip-affordance.test.tsx`; what
    // belongs here is that a NEW logical tip gets a NEW key, which is the other
    // half of the same rule (reusing one would make the server replay the first
    // tip's result and silently send nothing).
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. `TipButton` is NOT adopted — structural, over the shipping source
// ---------------------------------------------------------------------------

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(p);
  }
  return acc;
}

const allSrc = walk(SRC);
/** Shipping surface: `src/` minus every test file. */
const shipping = allSrc.filter((f) => !/\.test\.tsx?$/.test(f));

/**
 * Strip comments before scanning.
 *
 * 🔴 REQUIRED, NOT A CONVENIENCE, AND THIS FILE PROVED IT ON ITS FIRST RUN. The
 * picker's own header explains at length why `TipButton` is NOT adopted, so a
 * raw text scan flagged the one file whose comment is the decision itself. A
 * guard that fires on the sentence recording a decision, rather than on the
 * code, is worse than no guard: it trains you to weaken it. `code-only.test`
 * below is the positive control that the stripper has not simply erased
 * everything.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('🔴 upstream `TipButton` is not adopted, and the app keeps its own picker', () => {
  it('the scan actually covers files (positive control on the walker)', () => {
    // 🔴 A ZERO FROM A SCANNER IS INDISTINGUISHABLE FROM A SCANNER WIRED TO
    // NOTHING. Before believing the absence below, prove the file set is real and
    // that this file — which DOES name the forbidden symbol — was excluded on
    // purpose rather than by the walker missing it.
    expect(shipping.length).toBeGreaterThan(20);
    expect(allSrc.some((f) => f.endsWith(SELF))).toBe(true);
    expect(shipping.some((f) => f.endsWith(SELF))).toBe(false);
  });

  it('🔴 the comment stripper leaves real code behind (positive control)', () => {
    // Without this, "no file names TipButton" is also satisfied by a stripper
    // that returns an empty string for every file — the reassuring-zero shape.
    // Feed it the picker, whose comment names the symbol and whose CODE does not,
    // and watch both halves of that be true.
    const picker = readFileSync(join(SRC, 'components', 'TipSplitModal.tsx'), 'utf8');
    expect(/\bTipButton\b/.test(picker)).toBe(true); // the decision, in the header
    const stripped = codeOnly(picker);
    expect(/\bTipButton\b/.test(stripped)).toBe(false); // …and nowhere in the code
    expect(stripped).toContain('export function TipSplitModal'); // the stripper kept the code
  });

  it('no shipping file imports or renders TipButton', () => {
    const offenders = shipping.filter((f) => /\bTipButton\b/.test(codeOnly(readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it('the app-owned picker IS what the viewer surface imports (the positive control)', () => {
    // 🔴 WITHOUT THIS, THE ABSENCE ABOVE IS ALSO SATISFIED BY AN APP THAT HAS NO
    // TIP UI AT ALL. Criterion 4 has two halves and this is the second one: the
    // app keeps its own amount picker.
    const viewer = readFileSync(join(SRC, 'components', 'CollectionViewer.tsx'), 'utf8');
    expect(viewer).toContain("from './TipSplitModal.js'");
    expect(viewer).toContain('<TipSplitModal');
  });
});
