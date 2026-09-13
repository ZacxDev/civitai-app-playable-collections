// ---------------------------------------------------------------------------
// 🔴 THE LIST-GENERATION CONTRACT — every arm that REPLACES a list bumps it,
//    every arm that APPENDS to one checks it.
// ---------------------------------------------------------------------------
//
// `App.tsx` serialises its two paginated list feeds with a pair of counters per
// list. `discoverSeqRef` / `mineSeqRef` count replaces that were ISSUED and
// guard replaces against each other. `discoverAppliedRef` / `mineAppliedRef`
// count replaces that were APPLIED, and they are what an APPEND is validated
// against — because by the time an append launches, the replace that supersedes
// it has already bumped the request counter, so the two hold the same value and
// the request counter cannot tell them apart.
//
// That is a RELATIONSHIP between arms that live in four different functions, and
// no behavioural test can see it as a relationship — each one exercises a single
// path. Measured, and this file exists because of it: an isolated mutation sweep
// over the eight clauses found THREE that no behavioural case in the suite could
// kill (the bump in `loadDiscover`'s error arm, the generation clause in
// `loadMoreMine`'s catch arm, and the bump in `loadMine`'s signed-out
// short-circuit). Two of those now have behavioural cases in `App.test.tsx`;
// this file is what keeps the set honest as arms are ADDED, which is the case a
// per-arm test can never cover — a new replace arm written without a bump is
// invisible to every existing test by construction.
//
// 🔴 WHAT THIS CANNOT DO, STATED UP FRONT: it reads SOURCE TEXT, so it pins the
// shape of the code rather than its behaviour, and a sufficiently creative
// rewrite walks past it. It is the ledger, not the proof — the proof is the
// red/green behavioural cases in `App.test.tsx`. Its one job is to fail when the
// SET of writers or checkers grows or shrinks.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

/**
 * Every write that REPLACES a whole list, as it is spelled in `App.tsx`.
 *
 * The discriminator is the argument shape, and it is not cosmetic: a functional
 * update (`setDiscover((p) => …)`) derives the next state from the current one
 * and is how the APPEND and the in-flight flags are written, while an
 * object-literal argument throws the previous list away wholesale. Only the
 * second kind invalidates an in-flight append.
 */
const REPLACE_WRITES: ReadonlyArray<{ write: string; bump: string; why: string }> = [
  { write: 'setDiscover({\n        items: page.items,', bump: 'discoverAppliedRef.current++;', why: "loadDiscover success" },
  { write: 'setDiscover({ ...EMPTY_LIST, error: errMessage(err) });', bump: 'discoverAppliedRef.current++;', why: 'loadDiscover error' },
  { write: 'setMine({\n        items: page.items,', bump: 'mineAppliedRef.current++;', why: 'loadMine success' },
  { write: 'setMine({ ...EMPTY_LIST, error: errMessage(err) });', bump: 'mineAppliedRef.current++;', why: 'loadMine error' },
  { write: 'setMine(EMPTY_LIST);', bump: 'mineAppliedRef.current++;', why: 'loadMine signed-out short-circuit' },
];

describe('🔴 list-generation contract', () => {
  it('every whole-list REPLACE is immediately preceded by its generation bump', () => {
    for (const { write, bump, why } of REPLACE_WRITES) {
      // The write exists at all — otherwise the case below passes vacuously over
      // an arm that was renamed or deleted, which is the shrink direction.
      expect(APP, `${why}: the replace write itself is gone — update this ledger`).toContain(write);

      const at = APP.indexOf(write);
      const before = APP.slice(Math.max(0, at - bump.length - 24), at);
      expect(before, `${why}: this replace does not bump its applied-generation counter`).toContain(bump);
    }
  });

  it('the set of whole-list REPLACE writes has not GROWN past the ledger', () => {
    // The direction a per-arm test is structurally blind to. Any object-literal
    // `setDiscover({` / `setMine({` is a whole-list replace; if a new one is
    // added without being entered above, this fails and the author has to decide
    // whether it needs a bump (it almost certainly does).
    const literalWrites = [...APP.matchAll(/set(?:Discover|Mine)\((?:\{|EMPTY_LIST)/g)].length;
    expect(literalWrites).toBe(REPLACE_WRITES.length);
  });

  it('both APPEND loaders check the generation on BOTH arms', () => {
    // Two arms each — the success arm and the catch arm. The catch arm matters
    // for a reason that is easy to miss: it clears `loadingMore`, which after a
    // replace has landed belongs to a DIFFERENT generation's append that is
    // still in flight.
    expect([...APP.matchAll(/gen !== discoverAppliedRef\.current/g)]).toHaveLength(2);
    expect([...APP.matchAll(/gen !== mineAppliedRef\.current/g)]).toHaveLength(2);

    // …and each append loader captures the generation exactly once, at launch.
    // Capturing it after the await would read the post-replace value and make
    // every check above vacuously true.
    expect([...APP.matchAll(/const gen = discoverAppliedRef\.current;/g)]).toHaveLength(1);
    expect([...APP.matchAll(/const gen = mineAppliedRef\.current;/g)]).toHaveLength(1);
  });

  it('the capture happens BEFORE the request, not after the await', () => {
    // The ordering the whole mechanism rests on, read positionally: in each
    // append loader the capture must precede its `await api.listCollections`.
    for (const [captureRe, label] of [
      [/const gen = discoverAppliedRef\.current;/, 'loadMoreDiscover'],
      [/const gen = mineAppliedRef\.current;/, 'loadMoreMine'],
    ] as const) {
      const capture = APP.search(captureRe);
      expect(capture, `${label}: capture not found`).toBeGreaterThan(-1);
      const await_ = APP.indexOf('await api.listCollections', capture);
      expect(await_, `${label}: no request after the capture`).toBeGreaterThan(capture);
    }
  });
});
