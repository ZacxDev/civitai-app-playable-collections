// ---------------------------------------------------------------------------
// 🔴 THE RECORDED FOLLOW GAP, MADE MECHANICAL
// ---------------------------------------------------------------------------
//
// `App.tsx` and `CollectionViewer.tsx` both carry a prose note saying that
// upstream `FollowButton` "exposes no failure callback at all", so this app
// cannot learn that a follow outcome was AMBIGUOUS (a timeout, or a code-less
// server error raised after the row committed) and cannot drop its read cache
// the way the retired `useFollowToggle` did. The exposure is a stale `followed`
// flag for the cache TTL.
//
// Two prose notes and no check is exactly the shape that rots: the day upstream
// adds the prop, nothing tells us the gap is closable, and the notes quietly
// become false. This pins the prop surface as a LEDGER — it fails when the set
// GROWS (the gap is now closable: wire it, and delete those notes) and when it
// SHRINKS (something we depend on went away). It is a claim about the installed
// package, not about our code, and that is the point.
//
// 🔴 IT IS NOT A GUARD ON WORDS. A "no prop named onError" check is walkable by
// naming it `onFailure`, `onSettled`, `onReject` or anything else; the ledger
// compares the WHOLE SET, so any new prop under any spelling fails it.
//
// ⚠️ AND THE INSTRUMENT IS VALIDATED BEFORE ITS VERDICT IS READ. The first two
// cases feed the parser synthetic `.d.ts` text — one WITH a failure callback and
// one without — so a parser that silently matched nothing (a layout change
// upstream, a regex that stopped applying) cannot report a reassuring "the set
// is unchanged" while having read nothing at all.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The prop keys declared by `interface <name>` in a `.d.ts` source.
 *
 * Deliberately tiny and deliberately strict: comments are stripped first (a
 * `@example` block in the JSDoc contains `collectionId={...}` and prop-shaped
 * text), then the interface body is taken up to its first line-initial `}`, and
 * each `key?: ` / `'quoted-key'?: ` line yields one name. Returns them sorted so
 * the comparison is order-independent.
 */
export function propKeysOf(dts: string, interfaceName: string): string[] {
  const withoutBlockComments = dts.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = withoutBlockComments.indexOf(`interface ${interfaceName} {`);
  if (start === -1) return [];
  const body = withoutBlockComments.slice(start);
  const end = body.indexOf('\n}');
  const inner = end === -1 ? body : body.slice(0, end);
  const keys = new Set<string>();
  for (const line of inner.split('\n').slice(1)) {
    const m = /^\s{4}(?:'([^']+)'|([A-Za-z_$][\w$]*))\??\s*:/.exec(line);
    if (m) keys.add(m[1] ?? m[2]);
  }
  return [...keys].sort();
}

// The installed 0.49.0 surface. A bump that changes it fails here by design.
const FOLLOW_BUTTON_PROPS = [
  'collectionId',
  'collectionName',
  'data-testid',
  'disabled',
  'followed',
  'onChange',
  'size',
  'variant',
].sort();

describe('propKeysOf — the instrument, before its verdict is trusted', () => {
  it('positive control: it SEES a failure callback when one is declared', () => {
    const withFailure = `
export interface FollowButtonProps {
    /** doc */
    collectionId: number;
    onChange?: (followed: boolean) => void;
    /** The thing this app is waiting for. */
    onError?: (reason: string) => void;
}
`;
    expect(propKeysOf(withFailure, 'FollowButtonProps')).toEqual([
      'collectionId',
      'onError',
      'onChange',
    ].sort());
  });

  it('negative control: the same text without it yields a set that does NOT contain one', () => {
    const withoutFailure = `
export interface FollowButtonProps {
    collectionId: number;
    onChange?: (followed: boolean) => void;
}
`;
    const keys = propKeysOf(withoutFailure, 'FollowButtonProps');
    expect(keys).toEqual(['collectionId', 'onChange'].sort());
    // The two controls differ by exactly the prop under discussion, so a parser
    // wired to nothing cannot pass both.
    expect(keys).not.toContain('onError');
  });
});

describe("FollowButton's installed prop surface — the recorded gap", () => {
  const dtsPath = fileURLToPath(
    new URL('../node_modules/@civitai/blocks-react/dist/ui/FollowButton.d.ts', import.meta.url),
  );

  it('🔴 still exposes NO failure/timeout callback — the ambiguous outcome stays unobservable', () => {
    const dts = readFileSync(dtsPath, 'utf8');
    // Guard the guard: an empty read would make every assertion below vacuous.
    expect(dts.length).toBeGreaterThan(200);

    const keys = propKeysOf(dts, 'FollowButtonProps');

    // 🔴 THE LEDGER. Grows → upstream gave us something; check whether it closes
    // the ambiguous-outcome gap, wire it, and delete the prose notes in
    // `App.tsx` and `CollectionViewer.tsx` that say we cannot. Shrinks → a prop
    // this app passes may have gone away.
    expect(keys).toEqual(FOLLOW_BUTTON_PROPS);

    // And the specific consequence, stated so the failure above reads as what it
    // is rather than as a version nit.
    expect(keys).not.toContain('onError');
    expect(keys).not.toContain('onFailure');
  });

  it("the app passes only props this control declares (`onChange` is the sole callback)", () => {
    const dts = readFileSync(dtsPath, 'utf8');
    const keys = propKeysOf(dts, 'FollowButtonProps');
    const callbacks = keys.filter((k) => /^on[A-Z]/.test(k));
    expect(callbacks).toEqual(['onChange']);
  });
});
