# AGENTS.md

## Ship

Ship profile: `vercel-static`

**Integration: branch → PR → CI-gated auto-merge (canonical).** Open a PR from your branch; `.github/workflows/auto-merge.yml` enables squash auto-merge once **`CI / ci`** is green. Direct push to `main` is break-glass only.

Verify the active branch immediately before committing and pushing. The
`.git-hooks/pre-push` hook checks the actual destination ref and blocks direct
`main` updates. Only an explicitly authorized emergency may set
`GEOROIDS_BREAK_GLASS_PUSH=1`; routine `/ship` runs must use a feature branch.

GitHub protects `main`, including administrators: changes require a PR, an
up-to-date branch, and the GitHub Actions `ci` check. Force pushes and branch
deletion are blocked. Human approval and conversation resolution are optional so
CI-gated auto-merge can run unattended. The local break-glass variable does not
override these GitHub protections.

Persistent world state uses SQLite on the Railway `world-data` volume at `/data/world.sqlite`; `GEOROIDS_WORLD_PATH` is required in production. Apply the reviewed volume/path configuration before deploying server code. Local development defaults to `.data/world.sqlite`; integration runners explicitly use an in-memory database. Writes are write-behind through a worker thread (about a one-second loss window on a hard crash); the game loop never waits on the disk. See [world operations](docs/persistent-world.md).

Production is split: **Vite static client on Vercel** + **WebSocket game server on Railway**. Both services deploy from `main` through their own Git integrations. Verify each release independently; a successful Vercel deployment does not prove the Railway server deployed.

Local gate before push: `npm run gate` (full working-tree checks, including an empty index; shared dotagents preamble). It includes all unit and integration tests and constrained-client checks. Run it during the review/fix loop and again after final review fixes before pushing. GitHub CI independently runs parallel static validation and a small gameplay/touch/reconnect smoke, then requires both in `CI / ci`. See [CI and local review](docs/ci-and-local-review.md).

### Post-push verification (`/ship` step 12)

**Client-only changes** (default — `src/**`, client assets, docs, no server paths):

1. Wait for Vercel Git deployment READY (project `georoids`, team `jsollys-projects`).
2. Require the `x-release-id` response header at `https://www.georoids.com` to resolve to the merge commit or a descendant. The root Vercel middleware reads `VERCEL_GIT_COMMIT_SHA`; HTTP 200 alone does not prove the release.
3. Optional smoke: `<title>` is `GeoRoids` or page contains the Play button.
4. Record: `deploy: verified (Vercel Git)` at `https://www.georoids.com`

Do **not** curl `geoasteroids.com` — that domain is no longer registered (NXDOMAIN). The live client is **georoids.com**.

**Server changes** are classified by `node scripts/server-release-inputs.mjs --changed <base-sha> <merge-sha>` from the merged checkout. The classifier includes the TypeScript dependency graph rooted at `server.ts`, server/shared/setup/Railway paths, and runtime/build manifests. This includes server-consumed modules under `src/`. If it prints `true`:

1. Complete client verification above if the push also touched client files.
2. Wait for the [Railway](https://railway.app) deployment of the merged commit. Read-only API inspection on 2026-09-24 confirmed `enabled: true` and `canEnable: true` for the GitHub auto-deploy trigger; #704 deployed automatically from `main`. This supersedes the earlier `NO_INSTALLATION` state. If the expected deployment is missing or fails, inspect the current trigger and deployment state. A manual fallback must build the **exact merged commit SHA** through Deploy-this-commit or the MCP/API `commitSha` parameter. `railway redeploy` repeats the previous build and `railway up` uploads a local tree. Never apply unrelated staged environment patches; inspect staged changes before any manual deployment and stop if it would apply them.
3. Require `x-release-id` on `https://georoids-production-2403.up.railway.app/health` to resolve to the server merge commit or a descendant; verify the health JSON (`world.persistence.mode` is `worker`, `failed` is `false`, `world.loop` stalls are `0`) and multiplayer flow. Smoke: `curl -sf https://georoids-production-2403.up.railway.app/health` (if the Railway public URL changed, update Vercel production `VITE_WEBSOCKET_URL` to `wss://<new-host>/ws` and redeploy the Vercel client).
4. Record: `deploy: verified (Vercel Git)` plus `Railway: deploy required` or `Railway: verified`.

Do not run `vercel deploy` from `/ship` unless Git integration is broken.

### Production smoke workflow

The separate **Production smoke** workflow follows Railway’s successful
`GeoRoids / production` deployment event from `railway-app[bot]`. It verifies
the deployment SHA belongs to `main`, waits for that client release on Vercel,
and checks that same release on the server. This avoids racing Railway’s rollout
after CI completes. Manual runs check the supplied client and minimum server releases,
then uses the real production UI to join, receive snapshots, move, and fire.
It fails on stale releases, unhealthy persistence, stalled simulation, broken
interaction, browser errors, or a deadline. Logs, screenshots, traces, and a
machine-readable receipt are retained as workflow artifacts.

Run `npm run smoke:production` with `PRODUCTION_SMOKE_SHA` set to the full merged
SHA and `PRODUCTION_SMOKE_REQUEST_ID` set to a unique request ID. The checkout
must match that SHA. This production-only runner does not start local servers.
`PRODUCTION_SMOKE_SERVER_SHA` explicitly identifies a separate Railway release;
otherwise the classifier computes the last server-affecting commit.

During `/ship`, follow CI, deployment, and the exact smoke request to completion.
Use the canonical `skills/ship/scripts/follow-production-smoke.mjs` helper from
dotagents. Missing triggers require explicit dispatch; skipped, cancelled,
missing, timed-out, or failed smoke is not verified. After a Railway deployment,
request a fresh smoke run with its exact `server_sha`; an earlier client-only
success cannot verify that deployment. Fix post-merge failures in a new PR.
Triggers do not wake idle agents, and no recurring monitor is configured.

## Project

GeoAsteroids — a 2D multiplayer spaceship/asteroids game. Vite + TypeScript client (`src/`) talking to a Node WebSocket server (`server.ts` + `server/`) over `ws://`. Play the client at <https://www.georoids.com>; the authoritative server runs on Railway (see Deploy). Node `^24.15.0`.

## Deploy

Two separate deploy targets — client and server do not share a host.

### Vercel (static client)

| | |
| --- | --- |
| **Project** | `georoids` (`jsollys-projects`) |
| **Production URLs** | **Canonical:** <https://www.georoids.com>; **apex:** <https://georoids.com> (redirects to www); **Vercel default:** `https://georoids-jsollys-projects.vercel.app` |
| **Build** | `npm run build` → `dist/` (Vite; framework auto-detected) |
| **Trigger** | Merge to `main` after the pre-commit gate and PR CI; Vercel GitHub integration. Branch pushes do **not** create Preview deployments (`vercel.json` `git.deploymentEnabled`). |
| **Opt-in Preview** | Comment `/preview` as the first non-empty line on a same-repo PR (owner/member/collaborator User), or run workflow **Vercel Preview** with the PR number. GitHub runs that workflow from `main`. One-shot: new commits do not rebuild until you ask again. Requires GitHub secret `VERCEL_TOKEN`. Agents must not comment `/preview` unless the user asked. |
| **Local deploy** | None — no `npm run deploy` or CLI deploy step from `/ship` |

**Required Vercel production env vars:**

| Variable | Purpose |
| --- | --- |
| `VITE_WEBSOCKET_URL` | WebSocket endpoint baked into the client at build time. Currently `wss://georoids-production-2403.up.railway.app/ws`. Must match the live Railway public URL + `/ws`. |

`VITE_BUILD_TIME` and `VITE_COMMIT_HASH` are injected by `vite.config.ts` at build time — do not set on Vercel. The commit is the first valid 40-character SHA among `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, and `GEOROIDS_COMMIT_SHA`, then local Git. Empty hosted values do not block the later fallbacks. A missing or invalid commit stops the build because automatic client refresh needs that identity.

Local dev: `npm run dev` sets an empty `VITE_WEBSOCKET_URL` so `ConnectionManager` uses same-origin `/ws`. Vite proxies `/ws` and `/logs` to the configured local game-server port. This also supports phones using a public HTTPS tunnel to the Vite port. Direct Vite runs can override the endpoint in `.env.local` (see `.env.example`).

### Railway (game server)

| | |
| --- | --- |
| **Config** | `.railway/railway.ts` (Railpack, `node --import tsx server.ts`, healthcheck `/health`) |
| **Public URL** | `https://georoids-production-2403.up.railway.app` (WebSocket: `wss://georoids-production-2403.up.railway.app/ws`) |
| **Deploy** | GitHub auto-deploy from `main` is enabled (API verified 2026-09-24; #704 deployed automatically). Verify the exact merged release. If no deployment arrives, inspect the trigger and use a pinned `commitSha` fallback only when it does not apply unrelated staged patches. |
| **Server release verification** | Use `scripts/server-release-inputs.mjs` to classify changes, including server-consumed modules under `src/` and runtime/build manifests. |

Railpack installs dependencies and runs `npm run build` during the build. The
tracked [`.railway/railway.ts`](.railway/railway.ts) keeps the explicit
`startCommand` on Node with the installed `tsx` loader so the server owns
shutdown signals; restarts do not install packages or start the Vite client.
The IaC package is a development-only dependency and the CLI must be at least
5.42.1.

Railway stops reading legacy `railway.json` files on **2026-12-01**. The
[IaC migration](https://docs.railway.com/infrastructure-as-code) is now prepared
in `.railway/railway.ts`: it preserves the two existing service variables and
leaves generated Railway domains platform-managed. Before the first production
apply, link the exact GeoRoids production project/environment/service, run
`railway config plan --json`, and review the existing staged platform patch.
Apply only the reviewed plan; do not include variable values in source or plan
output. Authenticated pull/plan and service readback validate this definition;
the start-command update takes effect on the next deployment. Railway's verified
restart defaults are `ON_FAILURE` with 10 retries and are omitted from the IaC
because the platform importer omits these default values.

Smoke: `curl -i https://georoids-production-2403.up.railway.app/health`. The server exposes `RAILWAY_GIT_COMMIT_SHA` as `x-release-id` and health JSON `releaseId`; `dev` is local-only and never production proof.

The former `geoasteroids-production-2403.up.railway.app` hostname returns a Railway edge 404. Use the current `georoids-production-2403.up.railway.app` host for client configuration and verification.

## CI (local pre-commit gate)

- `.git-hooks/pre-commit` (wired via `core.hooksPath=.git-hooks`) runs dep grounding → Biome policy → Biome → Knip → ts-prune → Markdownlint → Yamllint → actionlint/ShellCheck → runner/dev process contracts → tsc + benchmark tsc → vitest → build. `npm run gate` also requires full integration + frame-work budget + constrained-client scenarios. It does **not** deploy. After the push lands, babysit the Vercel GitHub deployment in the dashboard.

### Actions helper exception

`scripts/check-actions.sh` intentionally differs from dotagents'
`templates/github/check-actions.sh`. GeoRoids downloads official Actionlint
v1.7.12 and ShellCheck v0.11.0 archives, verifies platform-specific SHA-256
checksums before extraction, and uses 10-second connect / 120-second total
download limits. The canonical helper instead obtains Actionlint through the
`github-actionlint` npm package; GeoRoids no longer depends on that wrapper.
Preserve this repo-local implementation and its verified archive cache. The
fleet doctor's comparison warning calls for review, not a byte-for-byte copy.
Run `npm run check:actions` when changing it.

## Commands

```shell
# Dev (Vite on :5173 + ws server on :3001 via concurrently)
npm run dev                # ./scripts/dev-server.sh
npm run dev:check          # status of dev servers
 npm run dev:kill           # stop only this checkout's owned dev session

# Build / typecheck / lint
npm run build              # wiki checks + tsc -p tsconfig.build.json + vite build
npm run check:ts           # tsc --noEmit
npm run check:lint         # biome check --error-on-warnings .
npm run check:lint-policy  # reject inherited warn/info Biome severities
npm run check:knip         # fail on unused files/exports/dependencies and config hints
npm run check:ts-prune     # fail on unconsumed TypeScript exports
npm run check:md           # markdownlint-cli2
npm run check:yaml         # yamllint --strict
npm run check:actions      # actionlint + ShellCheck
npm run check:fix          # biome check --write --error-on-warnings .
npm run fix                # biome write + tsc + unit tests

# Tests
npm run test               # unit only (tests/unit/)
npm run test:all           # unit, server, and entity integration tests
npm run test:review        # all integration + frame-work + constrained-client checks (also in gate)
npm run test:integration:browser   # browser tests via test-runner.sh
npm run test:integration:server    # server-side integration
npm run test:integration:entities  # entity integration

# Single test file (integration must use the runner script — not raw vitest)
./scripts/test-runner.sh tests/integration/browser/sanity/<file>.test.ts --reporter=verbose
npx vitest run tests/unit/path/to.test.ts        # OK for unit tests only
```

**Use `./scripts/test-runner.sh` for integration tests** — it enforces repository-scoped single-instance execution. Running `npx vitest` directly bypasses that lock and can open multiple Vitest workers, each spawning a WebSocket client to `:3001`, which hits the connection rate limiter and fails. The `vitest.config.ts` keeps `pool: 'forks'`, `maxWorkers: 1`, `isolate: true`, `fileParallelism: false`, `sequence.concurrent: false`, and `maxConcurrency: 1`; keep those settings.

## Architecture

### Two processes, one game

- **Client** (`src/`, served by Vite): rendering, input, prediction, HUD. Entry is `index.html` → bootstraps `GameController` (singleton) which wires `GameStateManager`, `PlayerManager`, `InputManager`, `NetworkManager`, `CollisionManager`.
- **Server** (`server.ts` → `server/`): authoritative game loop. `GameEngine` owns world state via `EntityManager`, `AsteroidManager`, deterministic `RNGService`. `WebSocketCore` (`server/communication/`) routes messages through `MessageHandler`. `GameStateBroadcaster` periodically pushes state.
- **Two WebSocket paths on the same server**: `/ws` for gameplay, `/logs` for forwarded client logs (`ClientLogger` writes them to `logs/client.log`). HTTP routes on the same port: `/health`, `/status` (HTML or JSON depending on Accept/UA), `/test-server-log` (development/test only).

Vite dev proxies `/ws` to `ws://localhost:3001` so the client always connects via the Vite origin.

Gameplay requires snapshot v1 and asteroid interactions. The client adds
`asteroidInteractions=1` to the WebSocket URL and sends both capabilities at join.
Unsupported clients receive HTTP 426 or an explicit join error; there are no
protocol opt-out flags or rollback procedure. Reconnects use a private resume token.

### Server-authoritative model

Asteroids live on the server; clients render snapshots. Clients still simulate their local ship for responsiveness. `playerNetwork.ts` and `network/networkManager.ts` handle outbound (input/shoot) and inbound (state) messages. Shared message/payload types live in `shared-types.ts` (top level, imported by both client and server).

### Key client modules

- `src/core/gameController.ts` — top-level lifecycle (`newGame`, `startGame`, `setupNetworkDisconnectionHandler`).
- `src/core/eventLoop.ts` — render/update loop.
- `src/entities/{player,ship,roid,laser,satellite,satellitePickup,loot}/` — entity classes and their managers/renderers. Ship motion and combat live in `Ship.ts` and its ship helpers.
- `src/physics/collision/{CollisionManager,collisionDetection}.ts` — collision system.
- `src/network/networkManager.ts` + `services/ConnectionManager.ts` — WS lifecycle, reconnection, message dispatch.
- `src/rendering/{canvas,boundaryRenderer,hud/}` — canvas + HUD; `GameController.renderGame` calls `canvasManager.drawGame`.
- `src/input/{PlayerInput,MockPlayerInput,mouse}.ts` — input abstraction; `MockPlayerInput` is what tests drive.
- `src/constants/index.ts` — single source of truth for tuning, `LOGGING`, and `DEBUG` flags.

### Debug & logging

Debug behavior is **constants, not env vars**. To enable debug mode, edit `src/constants/index.ts`:

1. `LOGGING.GLOBAL_LOG_LEVEL = 'debug'`
2. `DEBUG.ENABLED = true`

Notable flags under `DEBUG.*`: `ROIDS.{INITIAL_COUNT,MOVEMENT,PLACE_ON_LOCAL_PLAYER}`, `PLACE_PLAYERS_NEAR_BOUNDARY`. Client logs forward over `/logs` to the server; both ends append to:

- `logs/client.log` — client-side (forwarded over WS)
- `logs/server.log` — server-side

Logs are structured JSONL. Use `npm run --silent logs -- --player <id>` to merge a player's client/server timeline. Browser warnings, errors and sampled `STATE` checkpoints also reach Railway's searchable logs. See [docs/diagnostics.md](docs/diagnostics.md) for correlation, filtering, loss counters and profiling the actual game loop.

## Tests

- `tests/unit/` — pure, fast. Run via `npm run test`.
- `tests/integration/server/` — vitest against server modules directly.
- `tests/integration/entities/` — vitest against entity interactions and input behavior.
- `tests/integration/browser/` — Playwright driving a real browser. Organized by scenario: `sanity/`, `laser/`, `collision/`, `roid/`, `e2e/`. **Name each test for the user scenario it describes**, not the function under test — e.g. `ship-respawns-near-furnace-after-asteroid-death.test.ts` (what happens) over `test-collision.test.ts` (what's tested). Screenshots land in `tests/integration/browser/screenshots/`.

Integration tests start their own dev servers through `scripts/test-runner.sh` on unused configured ports. If a test hangs or fails strangely, inspect the runner output and confirm only its configured ports and child processes need cleanup before retrying.

## Project conventions

- **Keep the Wiki current when features change.** When adding, changing, or removing a feature, review the in-game Wiki at `/wiki/` and update affected controls, behavior, setup, and troubleshooting pages in the same work. Follow [manual maintenance](docs/wiki-maintenance.md), including its source-review gate. Remove obsolete instructions and verify links. If no Wiki page is affected, record that explicitly in the change verification.

- **Keep the Wiki brief.** Write two or three short sentences per feature: what to do, what happens, and the essential limitation. Put useful gameplay GIFs beside the explanation. Link to the owning topic instead of repeating instructions; keep exact values and detailed rules in the expandable reference. Preserve this field-guide format when adding features.

- **No barrel files / re-exports** — import from the defining module.
- **Relative paths only** — no `@`-style aliases.
- **No CDN for app assets** — never load runtime CSS or JS from CDNs. Prefer npm, local files, or same-origin Vite/Railway builds.
- **Biome** checks all authored formats it supports, including JavaScript/TypeScript, JSON/JSONC, CSS, HTML, and SVG (`biome.jsonc`). It respects `.gitignore` and excludes the generated npm lockfile. ESLint is gone. Knip and ts-prune check unused code; Markdownlint, Yamllint, actionlint, and ShellCheck cover their respective files. Every enabled lint diagnostic must fail its check, including Knip hints and ShellCheck info/style findings.
- **Singletons via `getInstance()`** for the top-level managers (`GameController`, `PlayerManager`, `CollisionManager`, etc.) — wire through these, don't `new` them.
- **The 60 Hz game loop never touches the disk or does O(world) work.** The saved world is read once at startup and lives in memory; changes leave the loop once a second as a batch through `WorldPersistence` (`server/world/`). Do not add SQLite calls, `fs` calls, or per-saved-sector scans to `advanceOneFrame` or the message handlers; `tests/unit/server/explored-world-keeps-the-simulation-frame-off-the-database.test.ts` and `world-writes-leave-the-game-loop-once-a-second.test.ts` fail if that regresses.
- **Shared types** go in `shared-types.ts` at repo root, not duplicated per side.
- **Conventional Commits** (`feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `docs`) with a scope (e.g. `feat(network): ...`).
- **Scenario-style test names** — describe a real user/system event, not the function under test.

## Local development

- **Integration deadline:** `GEOROIDS_TEST_MAX_DURATION_SECONDS` defaults to 1200; a timeout exits 124 and stops owned processes.
- **Integration tests:** always `./scripts/test-runner.sh`, never raw `npx vitest` on `tests/integration/`.
- **Node:** `package.json` requires `^24.15.0` (jsdom's Node 24 floor); `.nvmrc` is `24`.
- **`.env`:** an empty `.env` file must exist at the repo root (server startup uses `--env-file=.env`); create one with `touch .env` if missing.
- **`canvas` native deps:** the `canvas` npm package needs Cairo, Pango, libjpeg, libgif, and librsvg dev headers installed on the system.
- **Playwright browsers** (browser E2E): `npx --no-install playwright install chromium webkit`. If the headless-shell binary is missing, remove the stale lock (`rm -f ~/.cache/ms-playwright/__dirlock`) and reinstall.

### Services

| Service | Port | Health / URL |
| --- | --- | --- |
| Vite (client + `/ws` proxy) | 5173 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` → `200` |
| Game server (HTTP + WS) | 3001 | `curl http://localhost:3001/health` |

Start both with `npm run dev` (`./scripts/dev-server.sh`) for interactive development. The command refuses to attach to occupied ports; inspect the owner or choose isolated ports for integration tests. Status: `npm run dev:check`. Stop: `npm run dev:kill`, which signals only the process tree recorded for this checkout. Integration tests start their own pair through `scripts/test-runner.sh`; do not leave another service listening on the configured test ports.

**Background dev:** `nohup npm run dev > /tmp/geo-dev.log 2>&1 &` works; tail `/tmp/geo-dev.log` for startup errors.

### Lint / tests (reference)

See **Commands** above. Browser E2E must use `./scripts/test-runner.sh` (never raw `npx vitest` on `tests/integration/`).

### Hello-world smoke

For a manual smoke, open `http://localhost:5173`, click Play, steer (left/right arrow keys) and fire (Space); thrust is automatic. Or run `./scripts/test-runner.sh tests/integration/browser/sanity/game-initializes-with-arena-and-starting-state.test.ts --reporter=verbose`; the runner starts the required services on unused configured ports and asserts canvas, starting player state, and asteroids.

### Logs

`logs/client.log` and `logs/server.log` contain structured records; see [docs/diagnostics.md](docs/diagnostics.md). Enable verbose client logs in `src/constants/index.ts` (`LOGGING.GLOBAL_LOG_LEVEL`, `DEBUG.ENABLED`), not via env vars.

### Quick verification checklist

```bash
npm run check:lint         # biome check --error-on-warnings — should pass cleanly
npm run check:lint-policy  # fail closed if Biome defaults/overrides become warn/info
npm run check:knip         # unused files/exports/dependencies and config hints
npm run check:md           # markdownlint-cli2
npm run check:yaml         # yamllint --strict
npm run check:actions      # actionlint + ShellCheck
npm run check:ts           # tsc --noEmit — should pass cleanly
npm run test         # unit tests (~3s)
npm run build        # tsc -p tsconfig.build.json && vite build — produces dist/
```

## Verified-tree CI

PRs run static checks and the bounded behavioral smoke concurrently. The final
`ci` job requires both lanes to succeed. Full unit/integration/performance checks
run locally in the review gate. Post-merge CI reuses each successful PR lane only
when its recorded checkout tree exactly matches the landed tree, using
`scripts/ci-verified-tree.sh` from dotagents. Missing proof runs that CI lane;
manual runs always validate. The required `ci` name and deployment triggers stay intact.
Canonical contract: `~/code/dotagents/templates/github/verified-tree-ci.md`.

## Dependabot CI

Ordinary Dependabot PR events allocate no validation runners. A manually invoked
`/optimize-workspace` requests full PR checks with `deps:ci:<full-head-SHA>`.
Deferred checks cannot satisfy the real `ci` requirement. New commits need a new
request; skipped or absent checks never authorize a dependency merge. See the
canonical `dotagents/skills/optimize-workspace/references/dependencies.md`.
