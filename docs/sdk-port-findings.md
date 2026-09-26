# Porting off the `@civitai/blocks-react` bridge onto `@civitai/sdk` — measured scope

Status: **investigation complete, implementation deliberately not started.** Two
decisions below change what the central file (`src/App.tsx`) has to look like, so
building before they are answered would be rework rather than progress.

Measured against `origin/main` @ `65b0028` with `@civitai/sdk@0.7.0` installed and
read from `node_modules` — the authority this repo's `CLAUDE.md` names first
("the installed package itself"), not the starters working copy.

---

## 1. Bridge importers, by subpath

The fleet-level figure ("27 importers") conflates three populations, because
`'@civitai/blocks-react` prefix-matches its own subpaths. Anchored on the closing
quote:

| Population | Files | In scope |
|---|---:|---|
| root `'@civitai/blocks-react'` — **the bridge** | **6 static + 1 dynamic = 7** | **yes** |
| `'@civitai/blocks-react/ui'` — design-system pack | 7 | no — `civitai/civitai-app-starters#328` |
| `'@civitai/blocks-react/testing'` — the `Harness` | 15 | test scaffolding |

An unanchored `git grep -l '@civitai/blocks-react'` reports **39** files. That
number is the prefix artefact and should not be quoted as a scope.

**Root importers (the actual port surface):**

| File | Production? | What it takes from the bridge |
|---|---|---|
| `src/App.tsx` | yes | 9 hooks |
| `src/lib/popular.ts` | yes | 3 *types* only (`SharedAppendValue`, `SharedListItem`, `UseSharedStorage`) |
| `src/lib/viewer-maturity.ts` | yes | `useDomainMaturity` |
| `src/dev-transport.ts` | dev/test shim | `getTransport` |
| `src/lib/popular.test.ts` | test | types |
| `src/tip-contract.test.ts` | test | — |
| `src/scope-contract.test.ts` | test | **dynamic** `await import('@civitai/blocks-react')` |

`scope-contract.test.ts` is the 7th and is easy to miss: it consumes the root
export at *runtime* to enumerate every `use*` name, so a `from '…'` pattern does
not see it. It is also the file the port most disturbs — its contract is
"every `use*` export of `@civitai/blocks-react` is classified exactly once",
which has no meaning once the app's hooks come from a package that exports no
hooks at all.

Two further files read the package off **disk** rather than importing it, and a
port must not leave them pointing at a dependency the app no longer uses:
`src/follow-failure-contract.test.ts` (reads `dist/ui/FollowButton.d.ts`) and
`src/skin.test.ts` (scans the package root as a `PACK_ROOTS` entry).

### The corrected count

The brief's "7 root / 3 production" is right. The production trio is
`App.tsx`, `lib/popular.ts`, `lib/viewer-maturity.ts` — but note `popular.ts`
imports **types only**, so the runtime bridge surface in production is really
`App.tsx` + `viewer-maturity.ts`. `useDomainMaturity` in `viewer-maturity.ts` is a
**tenth** hook the nine-hook list omits.

---

## 2. Hook → SDK mapping, with evidence

Every row was checked against the installed `@civitai/sdk@0.7.0`. Paths are
relative to `node_modules/@civitai/sdk/`.

| Bridge hook | Bridge message | SDK equivalent | Evidence |
|---|---|---|---|
| `useAppStorage` | `APP_STORAGE_*` | `app.storage` | `dist/storage/index.d.ts`; `BREAKING.md` § App storage — "The SDK wraps them as `AppClient.storage`" |
| `useSharedStorage` | `SHARED_*` (10 msgs) | **no client** — 11 REST routes via `app.site` | `BREAKING.md` § Shared storage; `dist/site/index.d.ts` |
| `useBlockContext` | snapshot | `BlockAppClient.context` / `.viewer` / `.theme` + `onChange` | `dist/app/index.d.ts` |
| `useBlockToken` | snapshot | `snapshot.token` (`BlockToken`), or `app.getToken()` | `dist/core/transport.d.ts`, `dist/app/index.d.ts` |
| `useHostOrigin` | `getHostOrigin()` | `snapshot.hostOrigin` | `dist/core/transport.d.ts` — `BlockSnapshot.hostOrigin` |
| `useBlockResize` | `RESIZE_IFRAME` | `app.host.resize(h)` / `app.host.autoResize(el)` | `dist/host/index.d.ts` |
| `useRequestSignIn` | `REQUEST_SIGN_IN` | `app.host.requestSignIn({returnUrl?})` | `dist/host/index.d.ts` |
| `useRequestConsent` | `REQUEST_CONSENT` | **`app.requestGrants(scopes)`** | `dist/host/index.js:259-292` — notifies `REQUEST_CONSENT`, resolves `false` on `CONSENT_UNAVAILABLE` |
| `useBuzzBalance` | `GET_BUZZ_BALANCE` | `app.site.get('blocks/buzz')` → `{blue,green,yellow}` | `BREAKING.md` migration table |
| `useDomainMaturity` | snapshot | `snapshot.effectiveBrowsingLevel` (fall back to `maxBrowsingLevel`) | `dist/core/transport.d.ts` |

There is **no `useRequestConsent` twin**; the capability exists under a different
shape, as `requestGrants`, which resolves `true`/`false` instead of exposing the
notify. That is a better fit for this app — `App.tsx` currently has to pair the
notify with a separate `useConsentUnavailable` listener to know it was refused.

### Notes that change code, not just types

- **`app.site.get('blocks/buzz')` returns exactly the shape `totalBuzz()` already
  takes** (`{blue, green, yellow}`), so `src/lib/popular.ts`'s `totalBuzz` needs
  no change at all.
- **App storage has a migration delta**: anonymous viewers get **403** where the
  bridge resolved an anonymous read to `null` (`BREAKING.md` § App storage). The
  app must gate on `viewer` rather than reading an empty result as "nothing
  stored". `src/lib/browse-prefs.ts` is the consumer.
- **`GET /top` and `POST /increment` both exist now.** `src/lib/popular.ts`'s
  header says these were "never a real route" — that was true when it was
  written, and it no longer is. The REST port can therefore drop the
  `LIST_LIMIT = 200` fetch-and-rank-client-side workaround.
- **Only 3 of the 10 shared-storage methods are actually used** — `list`,
  `append`, `vote`, via `SharedStore`/`SharedReadStore` in `popular.ts`. A port
  does **not** need to reproduce `report`/`getCounts`/`update`/`unvote`/
  `withdraw`/`get`.
- **Shared-storage error bodies have three shapes** and the key carrying the
  reason depends on where the request died. Read `message ?? error` and branch on
  the HTTP status (`BREAKING.md` § Error body).

### The port is scope-neutral

`block.manifest.json` declares 8 scopes. The REST routes bind the *same* scopes
the bridge messages did — `apps:storage:read`/`write`,
`apps:storage:shared:read`/`write`, `buzz:read:self` — so
`src/manifest.test.ts`'s literal ledger needs **no** change and
`collections:write:self` stays absent, as `CLAUDE.md` requires.
`src/scope-contract.test.ts` does need rewriting, but because its *mechanism*
(enumerate a package's `use*` exports) no longer applies — not because the scope
set moves.

---

## 3. Decision 1 — `/ui` keeps the bridge alive, so what does the SDK attach to?

This is the finding that blocks implementation.

`/ui` is explicitly out of scope (issue #328). But two of the `/ui` components
this app renders are themselves bridge clients:

| Component | Used by | Pulls in |
|---|---|---|
| `BlockGate` | **`src/main.tsx:56` — wraps the production app root** | `useDirectLoad` → `getTransport()` |
| `FollowButton` | `src/components/CollectionViewer.tsx` | `useCollectionFollow`, `useRequestSignIn` → `getTransport()` |

Verified by enumerating the pack (`find … -print0 | xargs -0 grep`, because
`node_modules` is gitignored and a recursive `grep` is blind to it): exactly
three `/ui` files import from `../hooks/` or `../internal/` — `BlockGate`,
`FollowButton`, `TipButton`. This app renders the first two.

`BlockGate` wraps the production root, not just the harness branch. So **after a
port that leaves `/ui` alone, the blocks-react transport is still constructed on
every production boot.** A plain `initialize()` then builds a *second*
transport: both packages install their own `window` `message` listener, both
contain a `BLOCK_HELLO` sender and a `BLOCK_READY` auto-sender
(`blocks-react dist/internal/iframeTransport.js:166,314`;
`@civitai/sdk dist/core/transports/iframe-transport.js:177,274`), and each keeps
its own token copy and handles `TOKEN_REFRESH` independently.

Whether the host tolerates two `BLOCK_READY`s from one frame is a **platform**
question. It cannot be answered here — this repo's `CLAUDE.md` already says the
real host path needs a human in a mod-gated host. I tried to measure it in jsdom
and got an inconclusive result (blocks-react posted 0 `BLOCK_HELLO`, the SDK 1);
an absence with more than one candidate mechanism is not a finding, so I am
reporting it as unmeasured rather than as "only one greets".

### Options

1. **Adapter — share the one transport (recommended).** `initialize()` accepts
   `transport?: BlockTransport` precisely for this
   (`dist/app/index.d.ts` — "Replaces the page's own bridge"). Wrap the existing
   blocks-react singleton in the SDK's interface and hand it over: one handshake,
   one listener set, one token, `/ui` untouched, #328 stays independent.

   The two interfaces are **not** structurally compatible, so this is real code:
   `getSnapshot()` vs `snapshot.get()`, `sendMessage` vs `notify`, `onMessage` vs
   `on`, a separate `getHostOrigin()` vs a `hostOrigin` snapshot field, and
   blocks-react's `sendRequest` needs an explicit `responseType` the SDK's
   `request` does not pass.

   Costed for *this* app it is small and bounded. The SDK issues 6 request types
   overall, of which this app needs **one** (`REQUEST_TOKEN`); 3 notifies
   (`REQUEST_CONSENT`, `REQUEST_SIGN_IN`, `RESIZE_IFRAME`); and 1 push
   (`CONSENT_UNAVAILABLE`). Roughly one file. It is also the reversible option —
   delete the adapter and switch to plain `initialize()` once #328 lands.

2. **Accept two transports.** Smallest diff, but it ships an unverified protocol
   change in a block that handles money, and the failure mode (host confused by a
   second `BLOCK_READY`) is invisible locally.

3. **Pull `BlockGate` + `FollowButton` in scope.** Collides with #328, and for
   `FollowButton` it contradicts a load-bearing invariant in this repo's own
   `CLAUDE.md`: following is host-mediated, upstream `FollowButton` is the one
   control in all three views, and "closing that is an upstream prop, not a
   second follow implementation here."

**Recommendation: option 1.**

---

## 4. Decision 2 — where does the shared-storage client live?

`@civitai/sdk@0.7.0` exposes **no** shared-storage client. Verified on the
installed `dist` *and* on the starters working copy source (so it is not merely
unreleased): the only occurrences of "shared" are the two scope strings in
`session/index.ts`. The scope constants exist with nothing that consumes them.

The 11 REST routes do exist, and `BREAKING.md` documents them fully — methods,
paths, per-route scopes, the three error-body shapes, the anon-read rule and the
authenticated-writer trust gate. The migration intro says a block "now calls the
public `/api/v1` API (`app.site`) itself", and `SiteClient` is path-addressed by
design, so calling them is the documented path rather than an invented surface.

So this is not a platform gap. It is a question of **where the wrapper lives**:

- **App-local** (`src/lib/shared-storage.ts`, 3 methods) — unblocks this port now.
  Risk: every app that ports will write its own, and the vote/anon/trust
  semantics are subtle enough that they will diverge.
- **In `@civitai/sdk`** as `AppClient.sharedStorage`, mirroring how app storage
  got `AppClient.storage` — a PR in the starters repo, which is also what this
  repo's `CLAUDE.md` prescribes for a missing surface ("that is a PR there, not a
  workaround here"). Blocks this port on that release.

Given `#328` is already an open starters-side arc and app storage set the
precedent, I lean to the SDK, but it is a sequencing call and therefore yours.

---

## 5. Decisions already settled — recorded so they are not re-litigated

- **Analytics → no-op shim, and it is not a regression.** `TRACK_EVENT` is "not
  carried" (`BREAKING.md`), *and* it has no host handler today either —
  `hostHandlerParity.ts` marks both hosts N/A, "analytics fire-and-forget; no
  host-side sink wired". So `src/lib/analytics.ts`'s call sites are **already**
  no-ops on `main`. Keep one shim function rather than deleting N call sites.
- **`collections:write:self` must not return.** Dropped in 0.2.10; this port does
  not need it, and nothing here re-adds it.
- **a11y: nothing moves, and the `SegmentedControl` warning does not apply here.**
  That warning is about the pack's control changing role. This app never uses the
  pack's `SegmentedControl`: `src/components/ModeSwitcher.tsx` hand-rolls its own
  `role="radiogroup"` with `role="radio"` segments and a roving tabindex
  (lines 69, 79), and its header comment records the deliberate decision not to
  adopt the pack's `tablist` version until Track U settles. Both the segmented
  surfaces in this app (view-mode switch and media-type filter) go through that
  one local component. The jsdom Lit-modal defect is likewise a `/ui` concern and
  `/ui` is untouched — no role this app renders changes.

---

## 6. Baseline on `origin/main` @ `65b0028`

Runner: `node_modules/.bin/vitest` via the repo's own scripts in `package.json`.

| Command | Result |
|---|---|
| `pnpm test:jsdom` (`vitest run --project node --project dom`) | **58/58 files, 776/776 tests, exit 0** |
| `pnpm test` (adds `--project browser`) | **58 passed (61)**, 776/776, **1 unhandled error**, exit 1 |

The 3 files `pnpm test` cannot run are the browser tier
(`src/**/*.browser.test.tsx`), and the failure is environmental, not code:
Playwright 1.63 wants `chromium_headless_shell-1243`, the pinned
`PLAYWRIGHT_BROWSERS_PATH` supplies `1228`. `vite.config.ts` already documents
this and points at `nix-shell -p pnpm chromium`.

**So `main` is green on the two tiers that can run here, and any browser-tier
result from this machine is unreadable in both directions.** A port must be
gated on the browser tier somewhere that has a matching chromium.

---

## 7. Harness strategy, for when implementation starts

The app's real boundary after the port is `fetch`, not the transport — so a
transport-level mock host would answer a conversation nobody is having. Good
news: **the fetch-level seam already exists.** `src/Harness.tsx` records that the
mock host "does NOT answer any of the block HTTP endpoints … So the dev harness
(main.tsx) injects an in-memory fake `ApiClient` at the App boundary", and
`createFakeApi` is already what every `*.test.tsx` drives. The port extends that
fake to cover app storage, shared storage and buzz; it does not invent a new
mechanism.

`@civitai/sdk/testing` ships `createFakeTransport()` with `handle`/`reply`/
`fail`/`stall`/`push`/`setSnapshot`. That is the right tool for the *handshake*
half (snapshot, consent, sign-in, resize) and should be preferred over a
hand-rolled one; it is the wrong tool for the data half, which belongs on the
fetch fake.

15 files import the `Harness`. Any of them left asserting against a conversation
the app no longer has must be rewritten or deleted, **not** left passing —
`CLAUDE.md`'s own rule is that a test which skips itself or passes by accident is
worse than no test.
