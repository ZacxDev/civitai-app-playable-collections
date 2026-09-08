// 🔴 A DELETION NOBODY GUARDS IS ONE REFACTOR FROM COMING BACK.
//
// 0.2.11 removed an app-local age gate: `src/lib/mature-session.ts` (a
// session-level "I'm 18+" acknowledgement in module scope), the player's
// blur-until-accept overlay, and the grid's per-cover tap-to-reveal — which
// carried no age assertion at all, just a blur anyone could click away. Maturity
// is the viewer's own NSFW browsing level, set by the native control in the
// civitai site header and enforced by the host; the app renders that decision and
// must never re-ask it.
//
// This file asserts the mechanism is ABSENT FROM THE SHIPPING SOURCE. It has two
// halves, and only together are they worth anything:
//
//   STRUCTURAL — a deleted module, deleted exports and deleted testids cannot be
//   reintroduced under a different wording. These are the load-bearing checks.
//
//   SPELLED — the age-confirmation COPY. 🔴 Recorded honestly: a word guard is
//   walkable by rewording, so it is not proof that no gate exists. It is paired
//   with the BEHAVIOURAL guards in components/CollectionViewer.test.tsx ("there
//   is NO reveal affordance on any surface") and components/CollectionGrid.test.tsx,
//   which drive the real surfaces at over-ceiling content and assert that nothing
//   renders it.
//
// SCOPE: the SHIPPING surface only — non-test files under src/, plus index.html
// and block.manifest.json. Test files are excluded because the behavioural guards
// legitimately name `maturity-reveal` in order to assert it is not there, and this
// file itself is excluded because it necessarily quotes every forbidden string.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** This file's own basename — excluded from the scan, and the exclusion is counted. */
const SELF = 'deleted-mature-gate.test.ts';

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|css|html)$/.test(e)) acc.push(p);
  }
  return acc;
}

/** Every file in `src/` — used to prove the exclusions below remove what we think. */
const allSrc = walk(SRC);
/** The shipping surface: src minus every test file, plus the two root artefacts. */
const shipping = [
  ...allSrc.filter((f) => !/\.test\.tsx?$/.test(f)),
  join(ROOT, 'index.html'),
  join(ROOT, 'block.manifest.json'),
];
/**
 * Strip comments from a source file before scanning it.
 *
 * 🔴 REQUIRED, NOT A CONVENIENCE. This very rework left long headers in
 * `lib/maturity.ts` and `components/Maturity.tsx` explaining WHAT WAS DELETED and
 * why it must not return — the most valuable prose in the change. A scanner that
 * cannot tell a mechanism from a sentence about a mechanism would force those
 * comments out, i.e. the guard would delete the record of the thing it guards.
 * Block comments go; so does any line that starts with `//`. A trailing `//` after
 * code is deliberately KEPT (stricter, and it avoids mangling `https://` inside a
 * string literal). JSON and HTML are scanned verbatim — a manifest description is
 * shipped copy, not commentary.
 */
function stripComments(text: string, path: string): string {
  if (!/\.(ts|tsx|css)$/.test(path)) return text;
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}

const sources = shipping.map((path) => ({
  path,
  text: stripComments(readFileSync(path, 'utf8'), path),
}));
const rel = (p: string) => p.slice(ROOT.length);
const relOf = (s: { path: string }) => rel(s.path);

/** Identifiers and module paths that only the deleted gate ever had. */
const FORBIDDEN_SYMBOLS = [
  'mature-session',
  'useMatureGate',
  'acceptMatureGate',
  'isMatureGateAccepted',
  'resetMatureGate',
  'MaturityRevealOverlay',
  'MATURITY_BLUR_PX',
];

/** Testids the deleted reveal affordances rendered. */
const FORBIDDEN_TESTIDS = ['maturity-reveal', 'cover-reveal', 'cover-gate'];

/**
 * Testids the deleted "How to play" onboarding coach rendered (removed 0.2.14 on
 * operator feedback). Kept in its OWN constant rather than folded into
 * FORBIDDEN_TESTIDS above: these are two unrelated deletions, and merging them
 * would make a failure report name the maturity gate for an onboarding
 * regression. See the second `describe` at the bottom of this file.
 */
const FORBIDDEN_ONBOARDING_TESTIDS = ['onboarding-coach', 'onboarding-dismiss'];

/** Age-confirmation / reveal COPY. Walkable by rewording — see the header. */
const FORBIDDEN_COPY: RegExp[] = [
  /\b18\s*\+/,
  /\b18\s+or\s+older\b/i,
  /tap\s+to\s+reveal/i,
  /\bunblur/i,
  /confirm.{0,24}\byou(?:'|’)?re\b/i,
];

/** The exact strings the deleted UI shipped — the scanner's negative control. */
const REAL_DELETED_COPY = [
  "I'm 18 or older — reveal this collection",
  'I’m 18+ — reveal this collection',
  'Unblurs mature media for the rest of this session',
  'Tap to reveal',
];

describe('the scanner itself (validate the instrument before reading its verdict)', () => {
  it('POSITIVE CONTROL: it is actually reading a non-trivial set of shipping files', () => {
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.map(relOf)).toContain('index.html');
    expect(sources.map(relOf)).toContain('block.manifest.json');
    // …and it can SEE content: a symbol the rework introduced is found in the
    // three surfaces that must read the ceiling, plus the module that defines it.
    const seesCeiling = sources.filter((s) => s.text.includes('useViewerCeiling')).map(relOf);
    expect(seesCeiling.length).toBeGreaterThanOrEqual(4);
    expect(seesCeiling).toContain('src/components/CollectionGrid.tsx');
    expect(seesCeiling).toContain('src/components/Player.tsx');
    expect(seesCeiling).toContain('src/components/ContinuousView.tsx');
  });

  it('the exclusions remove exactly what they claim (this file, and the test files)', () => {
    expect(allSrc.filter((f) => basename(f) === SELF)).toHaveLength(1);
    expect(sources.map((s) => basename(s.path))).not.toContain(SELF);
    // Test files are excluded on purpose; there must actually BE some, or the
    // "shipping surface" framing is a fiction.
    expect(allSrc.filter((f) => /\.test\.tsx?$/.test(f)).length).toBeGreaterThan(20);
  });

  it('NEGATIVE CONTROL: the copy patterns match the strings that really shipped', () => {
    // A guard that cannot go red is testing nothing. These are the literal labels
    // the deleted `MaturityRevealOverlay` and cover overlay rendered.
    for (const line of REAL_DELETED_COPY) {
      expect(FORBIDDEN_COPY.some((re) => re.test(line))).toBe(true);
    }
    // …and it does not fire on ordinary app copy (no false-positive trap).
    for (const line of ['This collection has no playable media.', 'Maturity rating R', 'Back to collections']) {
      expect(FORBIDDEN_COPY.some((re) => re.test(line))).toBe(false);
    }
  });

  it('the comment stripper removes commentary but keeps code on the same surface', () => {
    // Without this the stripper is a hole nobody measured: if it ate too much,
    // every scan above would pass vacuously.
    const sample = ["// I'm 18+ — reveal this collection", '/* Tap to reveal */', 'const label = "Tap to reveal";'].join(
      '\n',
    );
    const stripped = stripComments(sample, 'x.tsx');
    expect(stripped).not.toContain('18+');
    expect(stripped).toContain('const label = "Tap to reveal"');
    // A real STRING containing the copy still trips the scan.
    expect(FORBIDDEN_COPY.some((re) => re.test(stripped))).toBe(true);
    // Non-source files are never stripped — a manifest description is shipped copy.
    expect(stripComments('// not a comment here', 'block.manifest.json')).toContain('// not a comment here');
  });
});

describe('the app-local age gate is deleted and stays deleted', () => {
  it('🔴 src/lib/mature-session.ts does not exist', () => {
    expect(existsSync(join(SRC, 'lib', 'mature-session.ts'))).toBe(false);
    expect(existsSync(join(SRC, 'lib', 'mature-session.tsx'))).toBe(false);
  });

  it('🔴 no shipping file references the gate module or any of its exports', () => {
    const hits: string[] = [];
    for (const { path, text } of sources) {
      for (const sym of FORBIDDEN_SYMBOLS) if (text.includes(sym)) hits.push(`${rel(path)} → ${sym}`);
    }
    expect(hits).toEqual([]);
  });

  it('🔴 no shipping file renders a reveal affordance testid', () => {
    const hits: string[] = [];
    for (const { path, text } of sources) {
      for (const id of FORBIDDEN_TESTIDS) if (text.includes(id)) hits.push(`${rel(path)} → ${id}`);
    }
    expect(hits).toEqual([]);
  });

  it('no shipping file carries age-confirmation or reveal copy', () => {
    const hits: string[] = [];
    for (const { path, text } of sources) {
      for (const re of FORBIDDEN_COPY) {
        const m = re.exec(text);
        if (m) hits.push(`${rel(path)} → ${JSON.stringify(m[0])}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('the store listing makes no maturity promise the code does not keep', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'block.manifest.json'), 'utf8')) as {
    version: string;
    description: string;
    contentRating: string;
  };

  it('🔴 the description no longer promises a blur-until-you-confirm gate', () => {
    // The exact sentence that shipped through 0.2.10. A moderator and a viewer
    // both read this field; leaving it would describe a mechanism that no longer
    // exists.
    expect(manifest.description).not.toContain(
      "Anything rated above PG-13 stays blurred until you confirm once that you're 18+.",
    );
    expect(manifest.description).not.toMatch(/blur/i);
    expect(manifest.description).not.toMatch(/\b18\b/);
  });

  it('says NOTHING about maturity rather than something unverifiable', () => {
    // Deliberately not replaced with a different promise: the app makes no
    // maturity claim of its own — the platform's ceiling is the whole mechanism.
    expect(manifest.description).not.toMatch(/mature|nsfw|age[- ]?gate/i);
    // The declared rating is still a real, checked claim and is untouched.
    expect(manifest.contentRating).toBe('pg13');
  });
});

// ---------------------------------------------------------------------------
// A SECOND, UNRELATED DELETION, guarded here because this file already owns the
// scanner and its controls — not because it is the same subject.
//
// 🔴 THE FILENAME IS HISTORICAL AND NOW NARROWER THAN THE CONTENTS. It was written
// for the 0.2.11 age-gate removal; 0.2.14 removed the "How to play" onboarding
// coach and reuses the same instrument. Renaming the file would break every
// reference to it in the handoff docs and the capture recipe, so the name stays
// and this comment carries the correction. If a THIRD deletion lands here, rename.
//
// The scanner's POSITIVE control (it reads >30 real shipping files, and can SEE
// content in them) is asserted once, in the first `describe` at the top of this
// file, and covers this section too — it is the same `sources` array.
// ---------------------------------------------------------------------------

describe('the "How to play" onboarding coach is deleted and stays deleted', () => {
  it('the coach module is gone from the tree', () => {
    expect(existsSync(join(SRC, 'lib', 'onboarding.ts'))).toBe(false);
    expect(existsSync(join(SRC, 'lib', 'onboarding.tsx'))).toBe(false);
  });

  it('🔴 no shipping file renders either coach testid', () => {
    const hits: string[] = [];
    for (const { path, text } of sources) {
      for (const id of FORBIDDEN_ONBOARDING_TESTIDS) {
        if (text.includes(id)) hits.push(`${rel(path)} → ${id}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no shipping file references the deleted hook', () => {
    const hits: string[] = [];
    for (const { path, text } of sources) {
      if (text.includes('useOnboarding')) hits.push(rel(path));
    }
    expect(hits).toEqual([]);
  });

  it('NEGATIVE CONTROL: the testid check really fires on the markup that shipped', () => {
    // 🔴 Without this, "hits is empty" is a claim about the loop, not about the
    // tree — the same reassuring zero the header warns about. These are the exact
    // attributes the deleted card rendered.
    const asShipped = [
      '<Card padding="md" data-testid="onboarding-coach" style={coachCard}>',
      '<Button size="sm" onClick={onboarding.dismiss} data-testid="onboarding-dismiss">',
    ];
    for (const line of asShipped) {
      expect(FORBIDDEN_ONBOARDING_TESTIDS.some((id) => line.includes(id))).toBe(true);
    }
    // …and it does not fire on ordinary app copy, so it cannot pass by matching
    // everything.
    for (const line of ['<Card padding="md" data-testid="viewer-settings">', 'Back to collections']) {
      expect(FORBIDDEN_ONBOARDING_TESTIDS.some((id) => line.includes(id))).toBe(false);
    }
  });
});
