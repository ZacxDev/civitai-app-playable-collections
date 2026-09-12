# Playable Collections — agent guide

A Civitai **App Block**: a full-page (W10) page app served at
`/apps/run/playable-collections` that plays a collection's images and videos
straight through — slideshow / ticker / wall, discovery of public + own
collections, and a cross-user "Popular" rail on App Blocks shared storage.

This repo is a **public OSS mirror** — block source only, no infrastructure
internals. Keep it that way.

**The load-bearing invariants** (read the file's own header comment before
touching it — each one records the defect it exists to prevent):

- **The tip is the only Buzz this app spends.** `src/lib/tip-allowance.ts` caps a
  single tip at the server's real `TIP_MAX_PER_TIP` (5000) and reads the
  remaining daily allowance **from the server**, never from localStorage — which
  throws in the opaque-origin sandbox and silently reported "nothing spent".
- **A split tip caps the SUM, not each leg.** `src/lib/tip-split.ts`: two legs
  would each pass the server's per-transfer gate, so 5000 is enforced on the
  total here. Every leg that exists carries at least `TIP_MIN`; a leg of 0 is not
  a tip.
- **There is exactly ONE tip affordance, and it is the same one on every
  surface.** `src/components/CollectionViewer.tsx` renders `viewerActionRow()`
  from one place — the normal surface, or inside the lightbox that covers it,
  never both — so `chrome-tip` and `chrome-follow` each appear exactly once in
  Slideshow, Ticker, Wall and the lightbox. The picker it opens
  (`src/components/TipSplitModal.tsx`) is the whole tip surface: 100% is a
  creator tip, 0% a curator tip, anything between a split. Four separate
  presses (`tip-creator`, `tip-curator`, `tip-split`, `follow-toggle`) lived on
  a `Player`-owned rail until T5, which made them structurally impossible to
  offer on Ticker and Wall. Pinned by
  `src/components/tip-affordance.test.tsx`.
- **Recipients are frozen at PRESS time, and playback pauses while the picker
  is open.** The snapshot is what makes the money correct (the media
  auto-advances); the pause is defence in depth. `CollectionViewer` freezes the
  pair in `tipOpenFor` and never re-reads `liveCreator`/`liveCurator` after the
  press.
- **The split plan and its idempotency keys are owned by `App`, and nothing
  lower.** Dismissing the picker, switching view mode and opening the lightbox
  all leave `CollectionViewer` mounted — but LEAVING the collection unmounts it,
  and a plan that dies there mints fresh keys the server cannot replay, paying a
  landed leg twice. That last case is the only one that discriminates, and it is
  pinned in `src/e2e-tip-split.test.tsx`.
- **Following is host-mediated and writes nothing on its own.** Upstream
  `FollowButton` is the one control in all three views (T5): `declined` renders
  NOTHING, `sign-in-required` routes to `REQUEST_SIGN_IN`, and every other
  rejection renders its own sentence rather than the bare code. 🔴 The app's own
  `src/lib/follow.ts` went with the consolidation, and with it the
  ambiguous-outcome read-cache drop (`onFollowUncertain`): `FollowButton`
  exposes no failure callback, so a timed-out follow can leave a stale
  `followed` flag for the cache TTL. Closing that is an upstream prop, not a
  second follow implementation here.
- **Maturity gating.** `src/lib/maturity.ts` + `src/components/Maturity.tsx`:
  anything above PG-13 stays blurred until the viewer confirms 18+ once.
- **Scopes.** `block.manifest.json` declares them; `src/manifest.test.ts` pins the
  exact list as a literal ledger, and `src/scope-contract.test.ts` pins that list
  against what `src/` actually calls. 🔴 **No count is written here on purpose.**
  This line used to say "six", which was true of `origin/main` and went stale the
  moment the per-viewer `apps:storage:{read,write}` pair was declared; the README
  carried "7 scopes" in three places while the manifest declared six. A number in
  prose is pinned by nothing — the ledger in `manifest.test.ts` is the only thing
  that pins the list, and it fails by name when the list moves.
  `collections:write:self` was dropped in 0.2.10 and must not return.

## Get a shell

`pnpm` and `node` are **not on PATH** outside the dev shell. The flake pins both:

```bash
direnv allow          # or: nix develop
pnpm install --frozen-lockfile
```

| Task | Command |
|---|---|
| The gates CI runs | `pnpm test && pnpm build` |
| Types only | `pnpm typecheck` |
| Mock host (SDK `<Harness>`) | `pnpm run dev:harness` → http://localhost:5187 |
| Platform approve-time validator | `civitai app validate` (the Go CLI, installed separately — the flake does not ship it) |

Harness URL toggles: `?viewer=anon`, `?theme=light`.

**Toolchain pins.** `.nvmrc` is the single authority for the node major — the
flake reads it with `builtins.readFile`, and CI reads it via
`node-version-file`. pnpm's major is stated twice (`flake.nix`'s `pnpmMajor` and
the `pnpm/action-setup` step) because the action reads only its own input or a
`packageManager` field this repo deliberately does **not** declare — adding one
would change what the *platform's* builder does, since `block.manifest.json`'s
`buildCommand: pnpm run build` runs against the same `package.json`.
`src/toolchain-lockstep.test.ts` fails if those two drift, or if someone
hardcodes a node version back into the workflow.

`pnpm-workspace.yaml` is not optional: it declares the single root package *and*
carries the `minimumReleaseAgeExclude` list without which `pnpm install` refuses
the pinned `@civitai/*` versions outright. Bumping any of them means updating
that list in the same commit.

Only `x86_64-linux` is exercised. The flake evaluates for `aarch64-linux` and
`aarch64-darwin` too; `x86_64-darwin` is absent because nixpkgs-unstable dropped
it, and listing it would hand an Intel-Mac contributor a `throw`.

## Where a change belongs

Most work that *looks* like a bug here is a gap one layer down. Canonical
checkouts live at `~/workspace/civit/<repo-name>`; sibling directories with a
suffix are topic worktrees of the same remotes, usually on a feature branch.

| The change is about | Repo | Local |
|---|---|---|
| This block's UI, player, tips, discovery, popular rail | **`ZacxDev/civitai-app-playable-collections`** (here) | — |
| A hook, a type, the mock host, the design system — anything imported from `@civitai/*` | **`civitai/civitai-app-starters`** | `civitai-app-starters` |
| Host/server behavior: the `/apps/run` page surface, block token + scope enforcement, the page money path, app storage, the follow bridge, submit/approval | **`civitai/civitai`** | `civitai` |
| `civitai app init/validate/submit`, login, dev tunnel | **`civitai/cli`** (Go) | `cli` |
| Public developer docs (developer.civitai.com) | **`civitai/civitai-developer-docs`** | `civitai-developer-docs` |

**All five `@civitai/*` packages ship from the one starters repo** —
`packages/civitai-{app-sdk,blocks-react,components,components-react,theme}`. A
missing hook, a wrong type, a mock host that doesn't simulate something: that is
a PR there, not a workaround here.

Useful landmarks in `civitai/civitai`: `src/pages/apps/run` (the page surface),
`src/pages/api/blocks/manifest-schema.ts` + `submit-version.ts`,
`src/server/services/blocks/`. Sibling app blocks worth reading for prior art:
`ZacxDev/civitai-app-gen-matrix`, `…-model-benchmarking`, `…-custom-generators`,
`…-sensei`, `…-requests`.

## Documentation sources, in authority order

1. **The installed package itself.** `node_modules/@civitai/<pkg>/dist/*.d.ts`
   and its `README.md` are the only source guaranteed to describe *the version
   this repo builds against*. Check `package.json` first. Subpaths matter:
   `@civitai/app-sdk` exports `./blocks`, `./scopes`, `./orchestrator`,
   `./schemas/app-block/v1.json`; `@civitai/blocks-react` exports `./ui` and
   `./testing`.
2. **https://developer.civitai.com/apps/** — `guide/{quickstart,concepts,embedding,theming,text-to-image,comfy-cloud}`
   and `reference/{hooks,manifest,messages,scopes,components,generation,cli}`.
   Best for *why* and for the message-bridge contract. ⚠️ The generated pages
   carry a `sources:` front-matter naming the package version they were built
   from, and it **lags** the version here — when the page and the `.d.ts`
   disagree, the `.d.ts` wins.
3. **The starters repo** — `docs/build-your-first-app-block.md`,
   `starters/examples/*`, and `starters/civitai-block-starter` (what
   `civitai app init` clones). Real code beats prose for "how is this hook
   meant to be used".
4. **The host implementation** in `civitai/civitai` — last-resort ground truth
   for server behavior the docs don't specify.

For React 19 / Vite / Vitest specifics, use the `context7` MCP tools rather than
recalling from memory.

## Verifying a change

`pnpm test` runs **two vitest projects** and both must be read — a failure in one
is invisible in the other:

- **`node`** — `src/**/*.test.ts`, pure logic, no DOM. The money math
  (`lib/tip-allowance.ts`, `lib/tip-split.ts`), the playlist engine and the
  view-mode engines live here on purpose.
- **`dom`** — `src/**/*.test.tsx`, jsdom + Testing Library, driving `<App/>` and
  `usePlayer()` against the SDK mock host and the injected `fake-api.ts` client.

`pnpm build` is `tsc --noEmit && vite build` — **vitest does not typecheck**, so a
green suite has already shipped past a type error here once. Run both.

**What cannot be verified here:** a real Buzz tip is Turnstile + auth gated, and
the follow bridge needs the host's own consent confirm. No local run, harness
run, or test proves a tip actually charged or a follow actually wrote — that
needs a human in a real mod-gated host. Say so plainly rather than reporting a
green suite as if it covered the money path. CI is likewise not the platform:
`.github/` is not part of the submitted bundle and the builder is a different
environment.

New guards should pin a *relationship* that cannot rot on a routine bump, and be
watched failing before they are trusted. `src/manifest.test.ts`'s version
lockstep and `src/toolchain-lockstep.test.ts` are the pattern to copy — both
explain, in the file, the incident they exist to prevent.

🔴 **Adding a scoped SDK hook means adding its manifest scope**, and
`src/scope-contract.test.ts` is what enforces it — in both directions: a hook
called in `src/` whose scope is undeclared (which ships a feature the host
refuses on every call, silently, because both storage call sites swallow the
rejection), and a declared scope with no caller (a capability a moderator and
every viewer are shown for nothing). `manifest.test.ts` alone cannot see either:
it pins the declared list against a literal, so it stayed green over a build
whose persistence never worked in production. If an SDK bump adds a hook or a
scope, that file fails by name until the new one is classified.

## Release protocol

- `block.manifest.json` and `package.json` versions move **together**.
  `src/manifest.test.ts` enforces it; this repo's copy of that guard is one of
  the two that caught the 2026-08-27 batch that bumped only the manifest in
  seven apps.
- Bumping any `@civitai/*` dependency also means updating
  `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, and re-checking
  `taste.json`'s `sdkVersionAtPass` — the skin overrides tokens `@civitai/theme`
  declares, so a theme bump is the thing most able to move it out from under us.
- `.env.production` bakes the allowed parent origins into the bundle at build
  time. Wrong value = the transport drops every host message and the iframe
  renders blank.
