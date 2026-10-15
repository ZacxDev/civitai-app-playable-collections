import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE @civitai/* PACKAGES MOVE AS A SET, AND A GREEN INSTALL DOES NOT PROVE
 * THEY AGREE.
 *
 * The six first-party packages this app depends on constrain each other:
 * `blocks-react` peer-ranges `app-sdk` and dependency-ranges `theme` +
 * `components`; `components-react` dependency-ranges `components`;
 * `components` dependency-ranges `theme` and peer-ranges `sdk`. pnpm does not
 * fail when those ranges merely OVERLAP at a version nobody installed, and a
 * range bumped on one side only can leave two copies of `theme` /
 * `components` in the tree — two token sheets, two element registries, and a
 * skin that applies to one of them. Every other guard in this repo would stay
 * green through that, because they read the copy `src/` resolves, not the
 * copy a package resolves internally.
 *
 * So this suite reads the INSTALLED manifests (the same evidence
 * `skin.test.ts` walks for tokens) and asserts the relationships directly:
 *
 *   1. every direct @civitai/* dependency is installed at a version its own
 *      declared range in `package.json` admits;
 *   2. every civitai-to-civitai range declared by an installed package
 *      (peer or dependency) admits the installed version of its target;
 *   3. the pnpm virtual store holds exactly ONE version of each direct
 *      @civitai/* package.
 *
 * The range checker below is deliberately small: it understands exactly the
 * shapes these packages declare (an exact pin, `^x.y.z`, and space-separated
 * `>=a <b` comparators) and THROWS on anything else, so a new shape fails by
 * name rather than being silently misjudged as satisfied.
 */

type Pkg = {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function installedPkg(name: string): Pkg {
  const path = fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Pkg;
}

function rootPkg(): { dependencies: Record<string, string> } {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> };
}

/** [major, minor, patch] — every version in this set is a plain x.y.z. */
function parse(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`unparseable version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Does `range` admit `version`? Supports an exact `x.y.z` pin (the
 * `@civitai/sdk` pin in package.json is one, deliberately), `^x.y.z`, and
 * `>=a <b …` compounds. Anything else throws — see the header. */
function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (/^\d+\.\d+\.\d+$/.test(r)) return cmp(version, r) === 0;
  if (r.startsWith('^')) {
    const base = r.slice(1);
    const [maj, min] = parse(base);
    // npm caret semantics: ^0.y.z pins the minor, ^x.y.z (x>0) pins the major.
    const upper = maj > 0 ? `${maj + 1}.0.0` : `0.${min + 1}.0`;
    return cmp(version, base) >= 0 && cmp(version, upper) < 0;
  }
  if (/^[><=]/.test(r)) {
    return r.split(/\s+/).every((part) => {
      const m = /^(>=|<=|>|<|=)(\d+\.\d+\.\d+)$/.exec(part);
      if (!m) throw new Error(`unsupported comparator: ${part}`);
      const c = cmp(version, m[2]);
      switch (m[1]) {
        case '>=':
          return c >= 0;
        case '<=':
          return c <= 0;
        case '>':
          return c > 0;
        case '<':
          return c < 0;
        default:
          return c === 0;
      }
    });
  }
  throw new Error(`unsupported range shape: ${range}`);
}

const DIRECT = Object.keys(rootPkg().dependencies).filter((n) => n.startsWith('@civitai/'));

describe('@civitai/* lockstep (installed manifests, not the lockfile text)', () => {
  it('finds the direct set it means to guard (positive control)', () => {
    expect(DIRECT.length).toBeGreaterThanOrEqual(6);
    for (const name of [
      '@civitai/app-sdk',
      '@civitai/blocks-react',
      '@civitai/components',
      '@civitai/components-react',
      '@civitai/sdk',
      '@civitai/theme',
    ]) {
      expect(DIRECT).toContain(name);
    }
  });

  it('every direct package is installed inside its own declared range', () => {
    const declared = rootPkg().dependencies;
    for (const name of DIRECT) {
      expect(satisfies(installedPkg(name).version, declared[name]), name).toBe(true);
    }
  });

  it('every civitai-to-civitai range admits the installed target', () => {
    for (const name of DIRECT) {
      const pkg = installedPkg(name);
      const ranges = { ...pkg.dependencies, ...pkg.peerDependencies };
      for (const [target, range] of Object.entries(ranges)) {
        if (!target.startsWith('@civitai/')) continue;
        if (!DIRECT.includes(target)) continue; // e.g. orchestration-client: not ours to pair
        expect(
          satisfies(installedPkg(target).version, range),
          `${name} declares ${target}@${range}, installed is ${installedPkg(target).version}`,
        ).toBe(true);
      }
    }
  });

  it('the virtual store holds exactly one version of each direct package', () => {
    const store = fileURLToPath(new URL('../node_modules/.pnpm', import.meta.url));
    const entries = readdirSync(store);
    for (const name of DIRECT) {
      const prefix = `${name.replace('/', '+')}@`;
      const versions = new Set(
        entries.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length).split('_')[0]),
      );
      expect([...versions], name).toHaveLength(1);
    }
  });
});
