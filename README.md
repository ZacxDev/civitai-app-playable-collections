# Playable Collections — Civitai App Block

A mobile-first, desktop-responsive **page app** (W10 full-page App Block) that
plays through a Civitai collection's images and videos like a media player —
auto-advancing images, looping videos, per-media **creator tips**, **curator
tips**, on-site **collection bookmark (follow)**, configurable pacing, discovery
of public + your own collections, and a cross-user **"Popular"** rail backed by
App Blocks shared storage.

> This is a Civitai **onsite App Block** — it runs in-platform at
> `playable-collections.civit.ai`, embedded by the Civitai host. Open it via
> [`civitai.com/apps/run/playable-collections`](https://civitai.com/apps/run/playable-collections),
> not the bare subdomain. See the [Civitai developer docs](https://developer.civitai.com).

This is **Wave 1B** of `plan-app-playable-collections-2026-07-13.md` (the app
scaffold). The server foundation (Wave 1A: the `collections:*` scopes + the
`/api/v1/blocks/{collections,tip}` endpoints) lands separately; this app talks
to that contract through a single swappable client (`src/lib/api.ts`) so a
contract adjustment is a one-file edit.

## Stack

Mirrors the `civitai-block-prompt-library` page-app template:

- **Vite** + **React 19** + **TypeScript** (strict), inline-style theming.
- **`@civitai/app-sdk@0.17.0`** + **`@civitai/blocks-react@0.20.0`** — the
  published block SDK (hooks + iframe transport + `@civitai/blocks-react/testing`
  mock host; `useHostOrigin()` for the validated API base).
- **Vitest** with two projects: `node` (pure logic) + `jsdom` (components/hooks/
  e2e via `@testing-library/react` and the SDK mock host).

## Layout

```
block.manifest.json     Page-app manifest: 7 scopes (settings are device-local, not manifest)
src/
  App.tsx               Top-level: discover/mine tabs, popular rail, player, optimistic follow/tip
  types.ts              Domain types mirroring the Wave 1A endpoint shapes
  settings.ts           Pure resolution of the viewer settings (snake_case manifest keys)
  manifest.ts           defineBlock validation with the known-incoming-scope exemption
  theme.ts / useMediaQuery.ts   Palette + the mobile/desktop responsive breakpoint
  lib/api.ts            THE swappable network boundary (all HTTP behind ApiClient)
  fake-api.ts           In-memory ApiClient for the dev harness + tests
  player/
    engine.ts           Pure playlist state machine (next/prev/wrap/shuffle/seek)
    usePlayer.ts        React hook: image auto-advance timing + video-loop counting
  components/
    Player.tsx          The full-page stage + overlay chrome + transport controls
    CollectionGrid.tsx  Discover/mine grid, cards, popular rail
    TipModal.tsx        Buzz amount picker (presets + custom, validation)
    toast.tsx           Toast queue + host
  main.tsx / Harness.tsx / dev-transport.ts   Dev-harness + prod entry wiring
```

## Run locally

```sh
npm install

# Dev harness — mounts the SDK mock host + the in-memory fake API (no backend).
# Opens on http://localhost:5187. URL toggles: ?viewer=anon, ?theme=light.
npm run dev:harness

# Type-check / build / test
npm run typecheck
npm run build          # tsc --noEmit && vite build -> dist/
npm test               # vitest run (node + jsdom projects)
```

> On a machine without `pnpm` on PATH, run the binaries directly, e.g.
> `~/.nix-profile/bin/npx vitest run`, `~/.nix-profile/bin/npm run build`.

## Settings (device-local)

Two playback prefs, persisted in **localStorage** — NOT manifest settings. A
page app can't use `block:settings:*` (the token mint's C8 gate requires the
caller to be the block *installer*, which a page app has none of, so it 403s),
and per-viewer manifest settings are unbuilt platform-wide. So these are
ephemeral device-local UI prefs, controlled by two in-app sliders in the player
chrome (the ⚙ button).

| localStorage key                          | Label             | Default | Range |
| ----------------------------------------- | ----------------- | ------- | ----- |
| `playable-collections:secondsPerImage`    | Seconds per image | 5       | 1–60  |
| `playable-collections:videoLoopCount`     | Video loop count  | 1       | 1–10  |

Read/clamped/persisted via `usePlayerSettings()` in `src/settings.ts`
(corrupt/missing → default; out-of-range → clamped). The player consumes the
resolved camelCase `PlayerSettings`.

## Scopes & the API host origin

All **7 scopes** are first-class in `@civitai/app-sdk@0.17.0` (the `BLOCK_SCOPES`
enum + the relaxed `BLOCK_SCOPE_PATTERN` that now accepts the 4-segment
`apps:storage:shared:*`), so `defineBlock` validates the manifest directly — the
earlier `KNOWN_INCOMING_SCOPES` strip-before-validate workaround is gone.

**API host origin (the run-page loop fix):** the block-token-gated API lives on
the **civitai host**, not the block's own subdomain, and the block runs
cross-origin. Fetching same-origin returned the block's SPA `index.html` → a
`JSON.parse` throw → (previously) an unbounded retry loop. The app now:

- derives the API base from **`useHostOrigin()`** — the SDK's allowlist-VALIDATED
  parent origin (never `document.referrer`), `undefined` until `BLOCK_INIT`;
- **gates all data-fetching on BOTH `host` and `token.raw`** being present — no
  client is built and nothing is fetched until then (the loading state shows).
  The HTTP client is memoized on the stable `token.raw` (not the fresh-every-
  render token object, which would itself loop);
- wraps the auto-run list loaders in **`withBoundedRetry`** (`src/lib/retry.ts`,
  ≤3 attempts): a persistent failure — a non-JSON/parse response, a 4xx, or an
  exhausted 5xx/network — lands in an error state with a manual retry, **never a
  loop**. Parse errors and 4xx are non-retryable (retrying returns the same
  result).

## Private collections & the consent gate

The app requests **7 scopes**. `collections:read:private` is **consent-gated**
(like `ai:write:budgeted`): the block-token mint withholds it until the viewer
grants it through the host's consent UI, and the server omits the viewer's
private collections / 404s private detail until the scope is on the token.

- **Consent helper:** `useRequestConsent()` (`@civitai/blocks-react`) →
  `requestConsent({ scopes: ['collections:read:private'] })`. Fire-and-forget:
  the host opens its consent UI and, on grant, re-mints the token and pushes a
  `TOKEN_REFRESH`.
- **Observing the re-mint:** the app reads `useBlockToken().scopes` — once
  `collections:read:private` appears on it (post-grant), an effect reloads the
  "My collections" list so private collections show without a manual refresh.
  (`src/scopes.ts` holds the predicate; `App` accepts an `isPrivateGranted` test
  seam that maps the mock host's consent scope for integration tests.)
- **My collections tab:** always lists public-own collections; when the private
  scope isn't granted it renders a "Show my private collections" affordance
  (`data-testid="private-consent"`) that triggers the consent gate. Declined /
  not-yet-granted degrades to public-only with the affordance still available —
  never a hard error.

## API contract notes for Wave 1A reconciliation

`src/lib/api.ts` implements the plan's contract exactly for the 4 documented
endpoints. Two surfaces are **not pinned by the plan** and are best-guesses to
reconcile when Wave 1A lands:

- **Buzz balance** (`buzz:read:self`): the plan wants a balance readout but pins
  no endpoint. `/api/v1/blocks/me` deliberately omits balance, so this app calls
  `GET /api/v1/blocks/buzz → { balance }`.
- **Shared play-counts** ("reuse the existing `apps:storage:shared:*`
  endpoints"): the `apps-shared.router` REST shape isn't in the contract. This
  app uses `POST /api/v1/blocks/shared-storage/increment { key }` and
  `GET /api/v1/blocks/shared-storage/top?prefix=playcount:&limit=N`.
- **Sort values**: the app/UI speaks `'newest'` / `'popular'`, but the deployed
  server's `CollectionSort` enum is `'Newest'` | `'Most Followers'`. `src/lib/api.ts`
  translates on the wire via `SORT_PARAM` (there is no name-sort on the service).
  `toApiError` also coerces any non-string error body to a string, so a server
  validation error (a `ZodError` object) can never crash the client.

## Links

- Developer docs — [developer.civitai.com](https://developer.civitai.com)
- Live app — [playable-collections.civit.ai](https://playable-collections.civit.ai)
- SDK contract — [`@civitai/app-sdk`](https://www.npmjs.com/package/@civitai/app-sdk)
- React hooks + UI pack — [`@civitai/blocks-react`](https://www.npmjs.com/package/@civitai/blocks-react)
- CLI — [`github.com/civitai/cli`](https://github.com/civitai/cli)
