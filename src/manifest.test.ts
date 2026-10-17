import { describe, expect, it } from 'vitest';

import { BLOCK_SCOPES } from '@civitai/app-sdk/blocks';

import pkg from '../package.json';
import { manifest, validateManifest } from './manifest.js';
import { RECIPIENT_PERCENT, TIP_TOTAL_MAX, type TipRecipientChoice } from './lib/tip-split.js';

describe('block.manifest.json', () => {
  it('declares the 10 required scopes (no block:settings:*, no collections:write:self)', () => {
    // 🔴 `apps:storage:read` / `apps:storage:write` — the PER-VIEWER store — are
    // NOT the same capability as the `apps:storage:shared:*` pair below, and the
    // host does not treat one as satisfying the other: it compares the required
    // scope against the token's scope set by EXACT STRING MATCH. This app needs
    // both families and declares both: the per-viewer pair backs the saved browse
    // preferences (`lib/browse-prefs.ts` via `useAppStorage`), the shared pair
    // backs the cross-user Popular rail (`lib/popular.ts` via `useSharedStorage`).
    //
    // Phase 3 adds the THIRD storage family: `apps:storage`, the DOCUMENT
    // store scope — again a distinct string no sibling satisfies. It backs the
    // `popular_plays` collection declared below, which the Popular rail is
    // migrating to. Both legacy families stay declared during the migration:
    // the per-viewer pair still backs browse prefs, and the shared pair backs
    // the rail's legacy half — the dual-read fallback and the write a failed
    // doc-store write falls back to (`lib/popular.ts`). Dropping either is a
    // later change, made when nothing reads it any more.
    //
    // Phase 3's reactions step adds `social:react:self` — CONSENT-GATED and
    // SENSITIVE (its justification below is a manifest requirement, not a
    // courtesy). It is the write half of the reaction bridge (`useReactions`):
    // the token carries it only after the viewer grants it. What a token
    // WITHOUT it means for the player is three-state (the tips pattern —
    // see CollectionViewer's gate docs): granted → the full reaction UI
    // over real reads; signed-in but ungranted → the buttons render
    // count-less, NO reads are issued, and a tap asks for the grant;
    // anonymous → no reaction UI at all. So a build whose manifest declares
    // the scope but which is not yet the approved version mints scope-less
    // tokens and lands every signed-in viewer in the middle state: the
    // surface is visible, the ask is one tap away, and nothing is read or
    // written until they grant.
    //
    // This literal ledger pins WHAT IS DECLARED. It cannot tell you whether the
    // code needs it — that relationship lives in `scope-contract.test.ts`, which
    // fails in BOTH directions (a called hook whose scope is undeclared; a
    // declared scope no caller wants). Read them as a pair; this one alone went
    // green over a build whose persistence was rejected by the host on every call.
    expect(manifest.scopes).toEqual([
      'collections:read:self',
      'collections:read:private',
      'social:tip:self',
      'buzz:read:self',
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
      'apps:storage',
      'social:react:self',
    ]);
    // 🔴 `collections:write:self` was DROPPED in 0.2.10 and must not come back.
    // Following moved to the host-mediated bridge, which needs no scope: the
    // host calls the session-authed procedure and self-binds the viewer. Re-adding
    // the scope would re-declare a capability the app no longer uses, and the
    // manifest `scopes` list is exactly what a moderator reads before install and
    // what the viewer inspects afterwards.
    expect(manifest.scopes).not.toContain('collections:write:self');
    // block:settings:* was removed — a page app has no installer, so the mint C8
    // gate 403s when they're declared.
    expect(manifest.scopes).not.toContain('block:settings:read');
    expect(manifest.scopes).not.toContain('block:settings:write');
  });

  it('every declared scope is a first-class SDK block scope (0.17.0)', () => {
    const known = new Set<string>(Object.values(BLOCK_SCOPES));
    for (const scope of manifest.scopes as string[]) {
      expect(known.has(scope)).toBe(true);
    }
  });

  it('passes defineBlock as the committed source manifest, unaugmented', () => {
    const validated = validateManifest();
    // 🔴 "UNAUGMENTED" IS THE CLAIM THAT MOVED. `@civitai/app-sdk@0.49.0` replaced
    // the hand-written `defineBlock` mirror with an Ajv compile of the canonical
    // schema and now REJECTS `iframe.src` ("SERVER-OWNED"), where the old mirror
    // REQUIRED it. So `src/manifest.ts` no longer synthesises `appId`, `targets`
    // or `iframe.src`, and what this validates is byte-for-byte the file
    // `civitai app submit` uploads rather than a local variant of it.
    //
    // Every declared scope validates directly (incl. the 4-segment shared-storage
    // ones and the consent-gated private read) — no exemption needed. The count
    // is deliberately not restated here; it rots on every scope change and the
    // ledger above is the place that owns it.
    expect(validated.scopes).toEqual(manifest.scopes);
    expect(validated.scopes).toContain('apps:storage:read');
    expect(validated.scopes).toContain('apps:storage:shared:read');
    expect(validated.scopes).toContain('collections:read:private');
  });

  it('declares the popular_plays document-store collection, write:"none", and no publish scope', () => {
    // The declaration IS the collection: undeclared, it does not exist and
    // every call is refused `collection_not_declared`. `write: "none"` is the
    // load-bearing choice — nobody authors a document, so the consent-gated
    // `apps:storage:publish` scope is NOT required and must not be declared
    // (a scope nothing needs is a capability disclosed for nothing; the
    // server's own manifest rules require publish only for `write: "own"` /
    // `"anyone"`). The counter and the mark must not share a name (the server
    // refuses that too): `plays` tallies raw plays and creates documents,
    // `played` is the per-viewer mark whose count ranks the rail.
    expect(manifest.storage).toEqual({
      collections: {
        popular_plays: { visibility: 'shared', write: 'none', counters: ['plays'], marks: ['played'] },
      },
    });
    expect(manifest.scopes).not.toContain('apps:storage:publish');
    // The declaration survives the canonical validator intact — what the
    // moderator reviews is what this file declares.
    expect(validateManifest().storage).toEqual(manifest.storage);
  });

  it('is a page app at "/" with NO manifest settings block (settings are localStorage-local)', () => {
    expect((manifest.page as { path: string }).path).toBe('/');
    expect(manifest.settings).toBeUndefined();
  });

  // 🔴 This was a LITERAL (`is version 0.2.2` / `toBe('0.2.2')`). It rots on every
  // version bump by construction: the 0.2.3 tagline release moved the manifest and
  // left the literal behind, turning `main` red on a bump that broke nothing. A
  // permanently-red gate is worse than no gate — it trains everyone to merge
  // through it, and the next real defect arrives looking exactly like this one.
  // The sibling app hit this same assertion and fixed it the same way
  // (civitai-app-model-benchmarking#5).
  //
  // The literal also pinned nothing worth knowing; "the version is the version"
  // teaches no reader anything. The invariant that MATTERS is that the manifest
  // and the package agree — the store reads one, the build reads the other, and a
  // bump touching only one is a real shippable defect. That cannot rot on a bump,
  // and it still fires when someone bumps just one of the two.
  it('keeps block.manifest.json and package.json versions in lockstep', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version).toBe(pkg.version);
  });

  // The description's MATURITY claim is asserted in src/deleted-mature-gate.test.ts,
  // beside the deletion it describes. What belongs here is that the field is still
  // a real listing: a moderator reads it, so it must not silently become empty or a
  // stub while a sentence is being removed from it.
  it('still carries a substantive store description across the 0.2.11 edit', () => {
    expect(typeof manifest.description).toBe('string');
    expect((manifest.description as string).length).toBeGreaterThan(600);
    expect(manifest.description as string).toContain('Slideshow');
    expect(manifest.description as string).toContain('Ambient mode');
  });
});

// ---------------------------------------------------------------------------
// T5 criterion 10 — the STORE DESCRIPTION, re-read against the shipped behaviour
// ---------------------------------------------------------------------------
//
// The description is the promise a moderator approves and a viewer reads before
// installing. The money sentence is the one T5 could have falsified, so it is
// checked against the code rather than eyeballed:
//
//   "The only Buzz the app spends is a tip you send — to the creator of the media
//    on screen, to the collection's curator, or split between the two — up to
//    5,000 Buzz per tip in total, with the amount and the split picked and
//    confirmed by you first."
//
// 🔴 Each clause below is tied to a VALUE the code owns, not to a keyword. A
// word guard is walkable by rewording and a verbatim guard is broken by a
// cosmetic edit; pairing the sentence with `TIP_TOTAL_MAX` and with the closed
// set of destinations is what makes it a claim about behaviour.
//
// ⚠️ The "confirmed by you first" clause is the one this file CANNOT settle: it
// is a statement about the picker's flow, and it is `tip-contract.test.ts` that
// pins the structural half (upstream `TipButton`, which confirms with no picker,
// is not adopted anywhere in the shipping source).

describe('the store description still describes what the app does (T5 criterion 10)', () => {
  const description = manifest.description as string;

  it('names every destination the ONE tip affordance can reach, and no other', () => {
    // The vocabulary the picker actually offers, read from the money module.
    const destinations = Object.keys(RECIPIENT_PERCENT) as TipRecipientChoice[];
    expect(destinations.sort()).toEqual(['creator', 'curator', 'split']);
    expect(description).toContain('to the creator of the media on screen');
    expect(description).toContain("to the collection's curator");
    expect(description).toContain('or split between the two');
  });

  it('quotes the SAME per-tip total the code enforces, and calls it a total', () => {
    // 🔴 THE NUMBER IS DERIVED, NOT TYPED. If `TIP_TOTAL_MAX` moves and the
    // description does not, this fails — which is the whole point: the cap is
    // enforced on the SUM of a split's legs, and the sentence says "in total"
    // for exactly that reason.
    expect(description).toContain(`up to ${TIP_TOTAL_MAX.toLocaleString('en-US')} Buzz per tip in total`);
  });

  it('still promises the viewer picks and confirms — the reason TipButton is refused', () => {
    expect(description).toContain('picked and confirmed by you first');
  });

  it('still claims a tip is the ONLY Buzz spend', () => {
    expect(description).toContain('The only Buzz the app spends is a tip you send');
  });
});
