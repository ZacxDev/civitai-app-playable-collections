# Playable Collections — Civitai App Block

A mobile-first, desktop-responsive **page app** (W10 full-page App Block) that
plays through a Civitai collection's images and videos like a media player —
auto-advancing images, looping videos, per-media **creator tips**, **curator
tips**, on-site **collection bookmark (follow)**, configurable pacing, discovery
of public + your own collections, and a cross-user **"Popular"** rail backed by
App Blocks shared storage.

This is **Wave 1B** of `plan-app-playable-collections-2026-07-13.md` (the app
scaffold). The server foundation (Wave 1A: the `collections:*` scopes + the
`/api/v1/blocks/{collections,tip}` endpoints) lands separately; this app talks
to that contract through a single swappable client (`src/lib/api.ts`) so a
contract adjustment is a one-file edit.

## Stack

Mirrors the `civitai-block-prompt-library` page-app template:

- **Vite** + **React 19** + **TypeScript** (strict), inline-style theming.
- **`@civitai/app-sdk`** + **`@civitai/blocks-react`** — the published block SDK
  (hooks + iframe transport + `@civitai/blocks-react/testing` mock host).
- **Vitest** with two projects: `node` (pure logic) + `jsdom` (components/hooks/
  e2e via `@testing-library/react` and the SDK mock host).

## Layout

```
block.manifest.json     Page-app manifest: 8 scopes, secondsPerImage/videoLoopCount settings
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

## Settings

Declared in `block.manifest.json` under **snake_case** keys (the platform +
`defineBlock` enforce `/^[a-z][a-z0-9_]{0,40}$/` on setting keys):

| Manifest key        | Label             | Scope  | Default | Range |
| ------------------- | ----------------- | ------ | ------- | ----- |
| `seconds_per_image` | Seconds per image | viewer | 5       | 1–60  |
| `video_loop_count`  | Video loop count  | viewer | 1       | 1–10  |

Read via `useBlockSettings().userSettings` and resolved to a camelCase
`PlayerSettings` in `src/settings.ts`.

## Known deviations from the published SDK (TODO(wave2))

- **`apps:storage:shared:read` / `apps:storage:shared:write`** are 4-segment
  scopes; the published SDK's `BLOCK_SCOPE_PATTERN` only accepts 3 segments, so
  `defineBlock` rejects them. `src/manifest.ts` strips them before calling
  `defineBlock` (see `KNOWN_INCOMING_SCOPES`) and validates them against a local
  allowlist. Remove once `@civitai/app-sdk` ships them.
- **`collections:read:self` / `collections:write:self`** are 3-segment, so they
  pass the pattern; they're simply absent from the SDK's `BLOCK_SCOPES` enum
  (which `defineBlock` does not check) — they validate fine today.

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
