# AGENTS.md

## Ship

Ship profile: `vercel-static`.

**Integration: branch → reviewed PR → merge on green `CI / ci`.** Follow [local release instructions](docs/development.md). Agents never push to `main`, change rulesets, or admin-merge.

Local gate: `npm run gate`; static checks, hook trust/bootstrap fixtures, runner contracts, the complete unit suite, build, and all server integration tests are mandatory. CI runs independent static, runner-contract, complete code-integration and Wiki media lanes; all must pass. Browser tests and automatic frame-work/constrained-client gates are retired.

Deploy: Vercel Git at <https://www.georoids.com> plus Railway Git at <https://georoids-production-2403.up.railway.app>. Classify server inputs with `scripts/server-release-inputs.mjs` from the merged checkout; its server/shared/setup/manifest inputs determine which Railway release needs verification, and it fails if server code imports `src/`. A successful client deployment cannot prove the server deployed. Successful production Git deployments establish the release. Do not gate builds or production smoke on served release metadata, bundle SHA searches or server SHA ancestry. Follow the canonical smoke receipt through asset availability, genuine join, snapshots, movement, accepted firing and healthy persistence. Production smoke uses HTTP/assets and WebSocket protocol evidence; it does not certify browser rendering, keyboard/touch controls, graphics or audio. Skipped, cancelled, failed or missing smoke is unverified.

Before deployment operations, read [agent operations](docs/agent-operations.md). Never apply unrelated staged Railway patches; fallback deploys must name the exact merged SHA. World persistence requires the reviewed production volume and `GEOROIDS_WORLD_PATH=/data/world.sqlite`; apply that configuration before server deployment. The game loop never waits for disk writes. Production configuration and destructive data changes remain human-owned.

## Project

GeoRoids — a cooperative open-world multiplayer spaceship game (surveying, asteroid towing, shared furnace deliveries). Astro static pages with Svelte 5 and shadcn-svelte interfaces plus a TypeScript canvas engine (`src/`) talking to a Node WebSocket server (`server.ts` + `server/`) over `ws://`, with rules both sides share in `shared/`. Play the client at <https://www.georoids.com>; the authoritative server runs on Railway (see Deploy). Node `^24.15.0`.

`AGENTS.md` (plus `tests/AGENTS.md`) is the only agent instruction file. Claude Code 2.1.277+ reads it natively; do not add a `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md`, because any of them makes Claude Code ignore `AGENTS.md`.

## Frontend stack

Astro owns static `/`, `/debug` and `/wiki` documents and manages Vite. Svelte 5
and committed shadcn-svelte primitives own page and DOM interfaces. TypeScript
owns canvas painting, geometry, simulation and multiplayer. Keep ordinary document navigation, relative
imports and imports from defining modules. Preserve the committed Svelte/shadcn-svelte components and accessible controls.

## Deploy

Astro static client and authoritative WebSocket server deploy independently from `main`. Before configuration or release work, read [deployment operations](docs/agent-operations.md#deploy) and [world operations](docs/persistent-world.md). Never use the retired geoasteroids hostnames. No automatic Vercel Preview deployments: Vercel is production-only. An owner, member or collaborator with repository write access can use a `/preview` PR comment to deploy that PR's head to the single shared Railway `preview` environment, where the game server also serves the built client ([Railway preview](docs/agent-operations.md#railway-preview)). Agents never comment `/preview` or dispatch `Railway Preview` unless John asks. A preview is not release evidence. `railway-preview.yml` deliberately replaces the fleet `vercel-preview.yml` template (completion-matrix row 11) and reuses its matcher; never add `vercel-preview.yml` or `vercel-preview-workflow-contract.sh` here, or one comment would start two previews.

## CI

The repository-owned trusted dispatcher runs the tracked pre-commit gate. The tracked pre-commit hook owns lint, unused-code checks, contracts, types, unit tests, build, complete server integration checks. `npm run gate` invokes that same complete battery with the docs exception disabled. Exact receipts may reuse unchanged validation; candidate reuse requires index parity. The repository pins and checksum-verifies its own actionlint/ShellCheck releases.

## Commands

Run `npm run gate` before publication. Testing instructions, suite ownership, runner isolation and manual browser smoke policy live in [tests/AGENTS.md](tests/AGENTS.md). Read [commands](docs/agent-operations.md#commands) before operating local services.

## Architecture

Astro serves and builds the static client with Vite; the Node WebSocket server owns authoritative world state. Shared gameplay rules live once under `shared/`; import them on both sides. Gameplay requires snapshot v3 and asteroid interactions; unsupported clients must reject, with no protocol opt-outs. Reconnects use private resume tokens. Read [architecture and diagnostics](docs/agent-operations.md#architecture) for module ownership and debugging.

## Tests

Read [tests/AGENTS.md](tests/AGENTS.md) for all testing instructions.

## Project conventions

- **Keep the Wiki current when features change.** When adding, changing, or removing a feature, review the in-game Wiki at `/wiki/` and update affected controls, behavior, setup, and troubleshooting pages in the same work. Follow [manual maintenance](docs/wiki-maintenance.md), including its source-review gate. Remove obsolete instructions and verify links. If no Wiki page is affected, record that explicitly in the change verification. Demonstration media belong to linux-x64; when CI's `wiki-media` lane fails, commit its regenerated baseline after inspection and review ([Generate or verify GIFs](docs/wiki-maintenance.md#generate-or-verify-gifs)).

- **Keep the Wiki brief.** Write two or three short sentences per feature: what to do, what happens, and the essential limitation. Put useful gameplay GIFs beside the explanation. Link to the owning topic instead of repeating instructions; keep exact values and detailed rules in the expandable reference. Preserve this field-guide format when adding features.

- **No barrel files / re-exports** — import from the defining module.
- **Relative paths only** — no `@`-style aliases.
- **No CDN for app assets** — never load runtime CSS or JS from CDNs. Prefer npm, local files, or same-origin Vite/Railway builds.
- **Biome** checks all authored formats it supports, including JavaScript/TypeScript, JSON/JSONC, CSS, HTML, and SVG (`config/quality/biome.settings.jsonc`). It respects `.gitignore` and excludes the generated npm lockfile. Pinned Prettier formats Astro/Svelte documents (`check:format`); `astro check` and `svelte-check` run framework diagnostics. Knip and ts-prune check unused code; Markdownlint, Yamllint, actionlint, and ShellCheck cover their respective files. Every enabled lint diagnostic must fail its check, including Knip hints and ShellCheck info/style findings.
- **Production managers use `getInstance()`** (`GameController`, `PlayerManager`, `CollisionManager`, etc.). `GameController` supplies PlayerManager's complete network capabilities at creation; later access cannot rebind them. Isolated runtime tests may construct PlayerManager and CollisionManager with explicit capabilities. `src/runtime/gameRuntime.ts` owns production EventLoop wiring and disposal. The Svelte shell owns its mount lifetime.
- **The 60 Hz game loop never touches the disk or does O(world) work.** The saved world is read once at startup and lives in memory; changes leave the loop once a second as a batch through `WorldPersistence` (`server/world/`); unchanged-membership asteroid sectors persist drift every `WORLD.driftFlushCheckpoints` checkpoints. Do not add SQLite calls, `fs` calls, or per-saved-sector scans to `advanceOneFrame` or the message handlers; `tests/unit/server/explored-world-keeps-the-simulation-frame-off-the-database.test.ts` and `world-writes-leave-the-game-loop-once-a-second.test.ts` fail if the loop reaches the disk. The work half has its own guard: an ordinary frame owes the asteroid belt exactly one motion pass, and only the once-a-second sector pass in `RegionalAsteroidField.update` may cost more. `tests/unit/server/the-frame-walks-the-asteroid-belt-once.test.ts` counts both, so a second full-belt walk in `advanceOneFrame`, or a fourth belt copy on the sector frame, fails. Reach a rare case through a tracked set or `spatialIndex()`, not `getAllAsteroids()`. See [belt passes per frame](docs/performance/belt-passes-per-frame.md).
- **Snapshots and terrain work stay local.** Snapshots send each player only nearby world entities (loot, projectiles, and other players' pickups within `WORLD.interestRadius`; asteroids within the smaller `WORLD.asteroidInterestRadius` radar circle, widened to the interest square while that pilot's Mineral Scan zooms the camera out; a player's own pickups always ship) (`shared/world.ts`; applied in `server/services/GameStateBroadcaster.ts`, with sectors waking at `WORLD.interestRadius` in `server/world/RegionalAsteroidField.ts`), and the client builds contours in local patches (`src/physics/terrain/terrainSession.ts`). Never broadcast or rebuild the whole world. `tests/unit/server/nearby-asteroid-queries-stay-local-as-the-world-grows.test.ts` guards regional asteroid queries and per-player asteroid row filtering, and `tests/unit/rendering/contours-follow-the-camera-without-dropping-lines.test.ts` guards contour patches; `tests/unit/server/pilots-share-snapshot-preparation-without-sharing-private-rows.test.ts` guards per-player filtering of loot, projectiles and non-owned pickup rows, and `tests/unit/server/satellite-inventory-survives-snapshots-and-brief-disconnects.test.ts` guards own-pickup visibility and stored-inventory privacy.
- **Shared types** go in `shared-types.ts` at repo root, not duplicated per side.
- **Conventional Commits** (`feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `docs`) with a scope (e.g. `feat(network): ...`).

## Local development

Node24 matches `.nvmrc`. Never attach to another checkout's services or kill listeners by port alone. Use `npm run dev`, `dev:check`, and `dev:kill` for this checkout's interactive session. Before provisioning native dependencies or running a smoke, read [local development](docs/agent-operations.md#local-development). Before `npm run gate` or `npm run dev` in a Claude Code cloud session, run `bash .cursor/install-app.sh` ([cloud sessions](docs/agent-operations.md#cloud-sessions)).

## Local UI verification

Start `npm run dev`; verify at origin `http://127.0.0.1:5173/` (routes `/`, `/debug`, `/wiki`) with no auth, following the basic manual browser smoke in [tests/AGENTS.md](tests/AGENTS.md#basic-manual-browser-smoke). A `/preview` URL is verified the same way at its preview origin. Personal skills are optional helpers.

## Verified-tree CI

PRs run static checks, runner contracts, the complete server integration suites, and Wiki media verification concurrently.
The final `ci` job requires all four lanes to succeed; failed, cancelled, or skipped
lanes fail the aggregate. Each lane has its own exact-tree proof.
Full unit and server integration checks run locally in the review gate. Manual performance measurements remain outside it. Post-merge CI reuses each successful PR lane only
when its recorded checkout tree exactly matches the landed tree, using
the repository-owned `scripts/ci-verified-tree.sh`. Missing proof runs that CI lane;
manual runs always validate. The required `ci` name and deployment triggers stay intact.
Canonical contract: [local CI helper](scripts/ci-verified-tree.sh).

## Dependabot CI

Ordinary Dependabot PR events allocate no validation runners. Only an explicitly
authorized manual maintenance run may apply `ow-ci`, after reviewing the current
same-repository PR head and recording the invocation and head as evidence. Apply
the label after the last push: only that `labeled` event runs real CI. A later
Dependabot push defers again; verify the new head and remove/re-add the label to
validate it. Scheduled or automatic maintenance grants no permission to approve,
rebase, rerun, label or merge dependency PRs. Personal maintenance skills are optional.
Deferred names ending in `-deferred`, skipped checks and absent checks cannot
satisfy required `ci`. Merge only the reviewed current head with successful real
CI. See the repository workflow and [release instructions](docs/development.md).

## Configuration

Move optional top-level tracked settings into `config/<domain>/` or their owner;
keep existing nested configuration with its component. Test configuration may live
under `tests/`. Give each setting one owner and retain minimal native adapters. See [configuration guidance](config/README.md)
for active native exceptions and path/scope verification. Commands select the
canonical owners directly; the native TypeScript entries retain required
framework/loader discovery and Svelte diagnostic scope. This repository owns them.

## Repository ownership

This repo maintains its executable helpers, agent instructions and workflow
contracts. Changes in another repo do not automatically rewrite this one. A
cross-repository migration needs the user's explicit scope, independent review,
and a separate verified PR in each affected repository.

## Git hooks

This repo owns `gate/gate-lib.sh` and `scripts/repo-hooks.py`. Run reviewed
`scripts/setup-agent-environment.sh` on main to install its outside-worktree
pre-commit dispatcher. Never set hooksPath to `.git-hooks`: a branch could then
register executable hooks. See [development and release](docs/development.md).

## Agent environment

Use this repository's AGENTS.md and [development guide](docs/development.md).
Run its reviewed `scripts/setup-agent-environment.sh` for pinned tools and hooks.
No private configuration repo, external instruction import or global skill is
required. Optional personal skills do not change this repository's authority.
