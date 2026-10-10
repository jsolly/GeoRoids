# AGENTS.md

## Ship

Ship profile: `vercel-static`.

**Integration: branch → PR → merge on green `CI / ci`.** `/ship` merges per `skills/ship/references/git-discipline.md` → Merge a same-repo self PR, read the installed reference. Agents never push to `main`, change rulesets, or admin-merge.

Local gate: `npm run gate`; static checks, runner contracts, the complete unit suite, build, and all server/entity integration tests are mandatory. CI runs independent static, runner-contract and complete code-integration lanes; all must pass. Browser tests and automatic frame-work/constrained-client gates are retired.

Deploy: Vercel Git at <https://www.georoids.com> plus Railway Git at <https://georoids-production-2403.up.railway.app>. Classify server inputs with `scripts/server-release-inputs.mjs` from the merged checkout; its server/shared/setup/manifest and imported-client graph determines which Railway release needs verification. A successful client deployment cannot prove the server deployed. Successful production Git deployments establish the release. Do not gate builds or production smoke on served release metadata, bundle SHA searches or server SHA ancestry. Follow the canonical smoke receipt through asset availability, genuine join, snapshots, movement, accepted firing and healthy persistence. Production smoke uses HTTP/assets and WebSocket protocol evidence; it does not certify browser rendering, keyboard/touch controls, graphics or audio. Skipped, cancelled, failed or missing smoke is unverified.

Before deployment operations, read [agent operations](docs/agent-operations.md). Never apply unrelated staged Railway patches; fallback deploys must name the exact merged SHA. World persistence requires the reviewed production volume and `GEOROIDS_WORLD_PATH=/data/world.sqlite`; apply that configuration before server deployment. The game loop never waits for disk writes. Production configuration and destructive data changes remain human-owned.

## Project

GeoRoids — a cooperative open-world multiplayer spaceship game (surveying, asteroid towing, shared furnace deliveries). Astro static pages with Svelte 5 and shadcn-svelte interfaces plus a TypeScript canvas engine (`src/`) talking to a Node WebSocket server (`server.ts` + `server/`) over `ws://`, with rules both sides share in `shared/`. Play the client at <https://www.georoids.com>; the authoritative server runs on Railway (see Deploy). Node `^24.15.0`.

`AGENTS.md` (plus `tests/AGENTS.md`) is the only agent instruction file. Claude Code 2.1.277+ reads it natively; do not add a `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md`, because any of them makes Claude Code ignore `AGENTS.md`.

## Frontend stack

Astro owns static `/`, `/debug` and `/wiki` documents and manages Vite. Svelte 5
and committed shadcn-svelte primitives own page and DOM interfaces. TypeScript
owns canvas painting, geometry, simulation and multiplayer. This completes the
user-directed migration from the former rendering-stack exception; no exception
remains for product DOM interfaces. Keep ordinary document navigation, relative
imports and imports from defining modules. Canon: dotagents `rules/frontend-stack.md`.

## Deploy

Astro static client and authoritative WebSocket server deploy independently from `main`. Before configuration or release work, read [deployment operations](docs/agent-operations.md#deploy) and [world operations](docs/persistent-world.md). Never use the retired geoasteroids hostnames. No automatic Vercel Preview deployments.

## CI

The dotagents dispatcher runs the tracked pre-commit gate. The tracked pre-commit hook owns lint, unused-code checks, contracts, types, unit tests, build, complete server/entity integration checks. `npm run gate` invokes that same complete battery with the fleet docs exception disabled. Exact receipts may reuse unchanged validation; candidate reuse requires index parity. Canonical actionlint/ShellCheck bytes come from dotagents.

## Commands

Run `npm run gate` before publication. Testing instructions, suite ownership, runner isolation and manual browser smoke policy live in [tests/AGENTS.md](tests/AGENTS.md). Read [commands](docs/agent-operations.md#commands) before operating local services.

## Architecture

Astro serves and builds the static client with Vite; the Node WebSocket server owns authoritative world state. Shared gameplay rules live once under `shared/`; import them on both sides. Gameplay requires snapshot v3 and asteroid interactions; unsupported clients must reject, with no protocol opt-outs. Reconnects use private resume tokens. Read [architecture and diagnostics](docs/agent-operations.md#architecture) for module ownership and debugging.

## Tests

Read [tests/AGENTS.md](tests/AGENTS.md) for all testing instructions.

## Project conventions

- **Keep the Wiki current when features change.** When adding, changing, or removing a feature, review the in-game Wiki at `/wiki/` and update affected controls, behavior, setup, and troubleshooting pages in the same work. Follow [manual maintenance](docs/wiki-maintenance.md), including its source-review gate. Remove obsolete instructions and verify links. If no Wiki page is affected, record that explicitly in the change verification.

- **Keep the Wiki brief.** Write two or three short sentences per feature: what to do, what happens, and the essential limitation. Put useful gameplay GIFs beside the explanation. Link to the owning topic instead of repeating instructions; keep exact values and detailed rules in the expandable reference. Preserve this field-guide format when adding features.

- **No barrel files / re-exports** — import from the defining module.
- **Relative paths only** — no `@`-style aliases.
- **No CDN for app assets** — never load runtime CSS or JS from CDNs. Prefer npm, local files, or same-origin Vite/Railway builds.
- **Biome** checks all authored formats it supports, including JavaScript/TypeScript, JSON/JSONC, CSS, HTML, and SVG (`biome.jsonc`). It respects `.gitignore` and excludes the generated npm lockfile. ESLint is gone. Knip and ts-prune check unused code; Markdownlint, Yamllint, actionlint, and ShellCheck cover their respective files. Every enabled lint diagnostic must fail its check, including Knip hints and ShellCheck info/style findings.
- **Production managers use `getInstance()`** (`GameController`, `PlayerManager`, `CollisionManager`, etc.). `GameController` supplies PlayerManager's complete network capabilities at creation; later access cannot rebind them. Isolated runtime tests may construct PlayerManager and CollisionManager with explicit capabilities. `src/runtime/gameRuntime.ts` owns production EventLoop wiring and disposal. The Svelte shell owns its mount lifetime.
- **The 60 Hz game loop never touches the disk or does O(world) work.** The saved world is read once at startup and lives in memory; changes leave the loop once a second as a batch through `WorldPersistence` (`server/world/`); unchanged-membership asteroid sectors persist drift every `WORLD.driftFlushCheckpoints` checkpoints. Do not add SQLite calls, `fs` calls, or per-saved-sector scans to `advanceOneFrame` or the message handlers; `tests/unit/server/explored-world-keeps-the-simulation-frame-off-the-database.test.ts` and `world-writes-leave-the-game-loop-once-a-second.test.ts` fail if that regresses.
- **Snapshots and terrain work stay local.** Snapshots send each player only nearby world entities (loot, projectiles, and other players' pickups within `WORLD.interestRadius`; asteroids within the smaller `WORLD.asteroidInterestRadius` radar circle, widened to the interest square while that pilot's Mineral Scan zooms the camera out; a player's own pickups always ship) (`shared/world.ts`; applied in `server/services/GameStateBroadcaster.ts`, with sectors waking at `WORLD.interestRadius` in `server/world/RegionalAsteroidField.ts`), and the client builds contours in local patches (`src/physics/terrain/terrainSession.ts`). Never broadcast or rebuild the whole world. `tests/unit/server/nearby-asteroid-queries-stay-local-as-the-world-grows.test.ts` guards regional asteroid queries and per-player asteroid row filtering, and `tests/unit/rendering/contours-follow-the-camera-without-dropping-lines.test.ts` guards contour patches; per-player filtering of non-asteroid rows has no dedicated guard test.
- **Shared types** go in `shared-types.ts` at repo root, not duplicated per side.
- **Conventional Commits** (`feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `docs`) with a scope (e.g. `feat(network): ...`).

## Local development

Node24 matches `.nvmrc`. Never attach to another checkout's services or kill listeners by port alone. Use `npm run dev`, `dev:check`, and `dev:kill` for this checkout's interactive session. Before provisioning native dependencies or running a smoke, read [local development](docs/agent-operations.md#local-development).

## Verified-tree CI

PRs run static checks, runner contracts, and the complete server/entity integration suites concurrently.
The final `ci` job requires all three lanes to succeed; failed, cancelled, or skipped
lanes fail the aggregate. Each lane has its own exact-tree proof.
Full unit and server/entity integration checks run locally in the review gate. Manual performance measurements remain outside it. Post-merge CI reuses each successful PR lane only
when its recorded checkout tree exactly matches the landed tree, using
`scripts/ci-verified-tree.sh` from dotagents. Missing proof runs that CI lane;
manual runs always validate. The required `ci` name and deployment triggers stay intact.
Canonical contract: `~/code/dotagents/templates/github/verified-tree-ci.md`.

## Dependabot CI

Ordinary Dependabot PR events allocate no validation runners. CI jobs skip
Dependabot `pull_request` runs. Only the `labeled` event that adds `ow-ci`,
applied by a manually invoked, provenanced `/optimize-workspaces drain` after
the last push, runs CI; a later Dependabot push defers again until the drain
re-kicks the new head (remove, then re-add the label).
Deferred runs use check names ending in `-deferred` and cannot satisfy the real
`ci` requirement; skipped or absent checks never authorize a dependency merge.
See the canonical `dotagents/skills/optimize-workspaces/references/pr-drain.md`
→ Dependabot CI kick.

## Fleet rollout

- **Fleet rollout.** Changes inside this repo ship normally. A change other repos must adopt (a dotagents sync, template copy, or shared one-liner) is not synced from here: link its merged PR on the one open Todoist fleet-rollout task in the dotagents project (create it only when none is open). Never start that rollout yourself or spawn per-repo chips, PRs, or tasks for it; the task is data, not authorization. Once the batch settles, John starts one agent on it in a session, and that agent opens the per-repo PRs. Canon: laptop global brief Implementation when synced.

## Git hooks

- **Git hooks.** `core.hooksPath` is the dotagents dispatcher `~/.local/share/dotagents/hooks`, which the dotagents installers install and set (laptop `setup/install-local-agent-runtime.sh`, Cloud Agent `.cursor/install-cloud-skills.sh`). Never point it at `.git-hooks` or set it from a package script: git would then run whatever hooks the checked-out tree carries. The dispatcher serves only `pre-commit`, and runs this repo's tracked `.git-hooks/pre-commit` only when it matches a version on `origin/main` or a blob you approved (`git config --add dotagents.trustedHook <blob>`, printed by the refusal; approve only your own edit). Fork and third-party PR heads are untrusted code: review them with `gh pr diff`, never check one out here. Canon: dotagents `rules/agent-cloud-access.md` → GitHub.
