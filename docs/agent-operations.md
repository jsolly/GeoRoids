# Agent operations

Read root `AGENTS.md` for controls. This guide owns commands, deployment procedures and module orientation. Commands run from the GeoRoids repository root; the primary laptop checkout is `/Users/johnsolly/code/GeoRoids`.

## Ship

Run `npm run gate` before publication and again after review fixes. Runner fault contracts share the heavy queue because their process inspection and cleanup contend with integration runs. It includes the full unit/integration suites, frame-work validation and constrained-client scenarios. GitHub independently runs parallel static checks and bounded gameplay/touch/reconnect smoke; both must pass `CI / ci`. Read [CI and local review](ci-and-local-review.md).

After merging, verify Vercel's Git deployment is READY for the merged commit at <https://www.georoids.com>. Classify server inputs with the classifier's `--changed` mode with the actual base and merge SHAs from the ship receipt. If the graph requires a server deployment, independently verify Railway's exact release; client success alone is insufficient. Railway auto-deploys main. If deployment is absent or red, inspect the actual trigger and staged platform changes before any exact-commit fallback; never use `railway redeploy` or upload a local tree as proof of the merged release.

Read `/ship`'s installed deploy and smoke references for the canonical follower invocation. Follow the exact release/request through the Production smoke workflow; its receipt uses `releaseSha` and `requestId`. The canonical runner checks HTTP and browser behavior; the GeoRoids scenario separately checks the server's health JSON identity and admitted gameplay connection. Preserve healthy persistent-worker state, zero game-loop stalls, protocol admission, authoritative snapshots, movement and a correlated accepted-shot acknowledgement. Headers alone are not release or gameplay proof.

Manual production smoke requires a full `PRODUCTION_SMOKE_RELEASE_SHA` and unique `PRODUCTION_SMOKE_REQUEST_ID`, with the checkout matching that SHA. `PRODUCTION_SMOKE_SERVER_SHA`, when supplied, names the separately deployed server; otherwise the classifier computes the minimum server-affecting commit. Use the workflow dispatch inputs `release_sha`, `request_id` and optional `server_sha`. The production runner starts no local server. After a new Railway deployment, follow a fresh smoke for that exact server release. Skipped, cancelled, missing, failed or timed-out smoke remains unverified. Artifacts retain observations, browser diagnostics, screenshots, trace and server admission evidence.

Open clients check the static same-origin `release.json` for the full build identity, confirm a changed identity twice and retain a per-loaded-build refresh guard. This product refresh behavior is distinct from host deployment proof. The `/wiki` and `/wiki/` rewrite preserves query parameters and remains independently covered.

## Deploy

Two separate deploy targets — client and server do not share a host.

### Vercel (static client)

| | |
| --- | --- |
| **Project** | `georoids` (`jsollys-projects`) |
| **Production URLs** | **Canonical:** <https://www.georoids.com>; **apex:** <https://georoids.com> (redirects to www); **Vercel default:** `https://georoids-jsollys-projects.vercel.app` |
| **Build** | `npm run build` → `dist/` (Vite; framework auto-detected) |
| **Trigger** | Merge to `main` after the pre-commit gate and PR CI; Vercel GitHub integration. Branch pushes do **not** create Preview deployments (`vercel.json` `git.deploymentEnabled`); GeoRoids has no Preview path. |
| **Local deploy** | None — no `npm run deploy` or CLI deploy step from `/ship` |

**Required Vercel production env vars:**

| Variable | Purpose |
| --- | --- |
| `VITE_WEBSOCKET_URL` | WebSocket endpoint baked into the client at build time. Currently `wss://georoids-production-2403.up.railway.app/ws`. Must match the live Railway public URL + `/ws`. |

`VITE_BUILD_TIME` and `VITE_COMMIT_HASH` are injected by `vite.config.ts` at build time — do not set on Vercel. The commit is the first valid 40-character SHA from `VERCEL_GIT_COMMIT_SHA`, then `RAILWAY_GIT_COMMIT_SHA`, then local Git. Empty hosted values do not block the later fallbacks. A missing or invalid commit stops the build because automatic client refresh needs that identity.

Local dev: `npm run dev` sets an empty `VITE_WEBSOCKET_URL` so `ConnectionManager` uses same-origin `/ws`. Vite proxies `/ws` and `/logs` to the configured local game-server port. This also supports phones using a public HTTPS tunnel to the Vite port. Direct Vite runs can override the endpoint in `.env.local` (see `.env.example`).

### Railway (game server)

| | |
| --- | --- |
| **Config** | `.railway/railway.ts` (Railpack, `node --import tsx server.ts`, healthcheck `/health`) |
| **Public URL** | `https://georoids-production-2403.up.railway.app` (WebSocket: `wss://georoids-production-2403.up.railway.app/ws`) |
| **Deploy** | GitHub auto-deploy from `main` is enabled (API verified 2026-09-24; #704 deployed automatically). Verify the exact merged release. If no deployment arrives, inspect the trigger and use a pinned `commitSha` fallback only when it does not apply unrelated staged patches. |
| **Server release verification** | Use `scripts/server-release-inputs.mjs` to classify changes, including server-consumed modules under `src/` and runtime/build manifests. |

Railpack installs dependencies and runs `npm run build` during the build. The
tracked [`.railway/railway.ts`](../.railway/railway.ts) keeps the explicit
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

Smoke: `curl -i https://georoids-production-2403.up.railway.app/health`. The server exposes `RAILWAY_GIT_COMMIT_SHA` in health JSON `releaseId`; `dev` is local-only and never production proof.

The former `geoasteroids-production-2403.up.railway.app` hostname returns a Railway edge 404. Use the current `georoids-production-2403.up.railway.app` host for client configuration and verification.

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
npm run check:wiki         # flag gameplay changes that need a Wiki review (runs in build)
npm run gate               # same complete pre-commit battery; exact unchanged receipts may reuse

# Tests
npm run test               # unit only (tests/unit/)
npm run test:all           # unit, server, and entity integration tests
npm run test:review        # all integration + frame-work + constrained-client checks (also in gate)
npm run test:integration:sharded   # complete integration suite, six owned serial shards
npm run test:integration:browser   # browser tests via test-runner.sh
npm run test:integration:server    # server-side integration
npm run test:integration:entities  # entity integration
npm run test:coverage      # unit tests with coverage

# Diagnostics / performance
npm run --silent logs -- --player <id>   # merged client/server timeline
npm run benchmark          # see benchmarks/README.md

# Single test file (integration must use the runner script — not raw vitest)
./scripts/test-runner.sh tests/integration/browser/sanity/<file>.test.ts --reporter=verbose
npx vitest run tests/unit/path/to.test.ts        # OK for unit tests only
```

**Use `./scripts/test-runner.sh` for integration tests** — it queues heavy validation across linked worktrees and excludes simultaneous validation in the same checkout. Running `npx vitest` directly bypasses that lock and can open multiple Vitest workers, each spawning a WebSocket client to `:3001`, which hits the connection rate limiter and fails. Full suites use six authenticated shards with at most three active children, weighted whole-file assignments, and separate services and artifacts. Each child retains serial execution. See [isolated shards](integration-shards.md). The `vitest.config.ts` keeps `pool: 'forks'`, `maxWorkers: 1`, `isolate: true`, `fileParallelism: false`, `sequence.concurrent: false`, and `maxConcurrency: 1`; keep those settings.

Use repository-relative or absolute paths for explicit test files; missing files fail before services start. Plain substrings such as `selected-pilot` remain text filters. A file location may have one numeric `:line` suffix. Put selectors directly after the runner command: Vitest ignores a nonempty `--` tail, so the runner refuses that tail instead of silently running a partial selection.

## Architecture

### Two processes, one game

- **Client** (`src/`, served by Vite): rendering, input, prediction, HUD. Entry is `index.html` → `src/core/main.ts`, which composes an injected `EventLoop` and bootstraps `GameController` (singleton) which wires `GameStateManager`, `PlayerManager`, `InputManager`, `NetworkManager`, `CollisionManager`.
- **Server** (`server.ts` → `server/`): authoritative game loop. `GameEngine` owns world state via `EntityManager`, `AsteroidManager`, deterministic `RNGService`. `WebSocketCore` (`server/communication/`) routes messages through `MessageHandler`. `GameStateBroadcaster` periodically pushes state.
- **Two WebSocket paths on the same server**: `/ws` for gameplay, `/logs` for forwarded client logs (`ClientLogger` writes them to `logs/client.log`). HTTP routes on the same port: `/health`, `/status` (HTML or JSON depending on Accept/UA), `/test-server-log` (development/test only).

Vite dev proxies `/ws` to `ws://localhost:3001` so the client always connects via the Vite origin.

Gameplay requires snapshot v2 and asteroid interactions. The client adds
`snapshotVersion=2` and `asteroidInteractions=1` to the WebSocket URL and sends both capabilities at join.
Unsupported clients receive HTTP 426 or an explicit join error; there are no
protocol opt-out flags or version-1 bridge. Client and server deploy independently;
joining can be unavailable until both hosts publish matching versions. Reconnects
use a private resume token. See [snapshot deployment](protocol/snapshot-v2.md#deployment).

### Server-authoritative model

Asteroids live on the server; clients render snapshots. Clients still simulate their local ship for responsiveness. `playerNetwork.ts` and `network/networkManager.ts` handle outbound (input/shoot) and inbound (state) messages. Shared message/payload types live in `shared-types.ts` (top level, imported by both client and server).

`shared/` holds the gameplay rules both sides must agree on (ship flight, combat, asteroid materials/reflection, furnaces, economy, exploration, world interest radii in `shared/world.ts`). Client prediction and the server simulation import the same module, so change a rule there once rather than mirroring it in `src/` and `server/`.

The injected slice covers EventLoop lifecycle, collision messaging, PlayerManager's
network port, and each Ship's combat capability. GameController creates the
production PlayerManager with NetworkManager's connection-owned capabilities;
authoritative snapshot creation passes that same connection's capability through
the factory to Player and Ship. Later singleton access cannot rebind an instance.
Other UI, world, rendering, telemetry, audio and network singleton entrypoints remain;
the tested independent graphs do not represent two complete games or sockets.

### Key client modules

- `src/core/gameController.ts` — top-level lifecycle (`newGame`, `startGame`, `setupNetworkDisconnectionHandler`).
- `src/core/eventLoop.ts` — injected render/update loop with owned RAF and visibility/start listeners; `dispose()` cancels its work and removes those listeners. `src/core/main.ts` owns browser startup and the production HUD callback.
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

Logs are structured JSONL. Use `npm run --silent logs -- --player <id>` to merge a player's client/server timeline. Browser warnings, errors and sampled `STATE` checkpoints also reach Railway's searchable logs. See [docs/diagnostics.md](diagnostics.md) for correlation, filtering, loss counters and profiling the actual game loop.

## Local development

- **Validation admission:** different worktrees can run ship gates together. Static checks overlap; complete reviews, focused integration and direct frame measurements wait for one heavyweight slot in the common Git directory. Queue waits print their ticket and can be cancelled with INT/TERM. A checkout admits one gate, review or standalone harness at a time because builds and live artifacts belong to that checkout.
- **Integration deadline:** `GEOROIDS_TEST_MAX_DURATION_SECONDS` defaults to 1200; a timeout exits 124 and stops owned processes. Admission wait precedes the runner and does not consume its execution deadline or the full suite’s 600-second deadline.
- **Test ports:** standalone harnesses automatically select distinct Vite, server and benchmark-proxy ports. Use explicit `GEOROIDS_TEST_VITE_PORT`, `GEOROIDS_TEST_SERVER_PORT` and `GEOROIDS_TEST_PROXY_PORT` only for diagnostics. Startup checks listener ownership and refuses occupied ports; interactive development retains its defaults.
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

### Hello-world smoke

For a manual smoke, open `http://localhost:5173`, click Play, steer (left/right arrow keys) and fire (Space); thrust is automatic. Or run `./scripts/test-runner.sh tests/integration/browser/sanity/game-initializes-with-arena-and-starting-state.test.ts --reporter=verbose`; the runner starts the required services on unused configured ports and asserts canvas, starting player state, and asteroids.
