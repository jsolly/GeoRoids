# Agent operations

Read root `AGENTS.md` for controls. This guide owns commands, deployment procedures and module orientation. Commands run from the GeoRoids repository root; the primary laptop checkout is `/Users/johnsolly/code/GeoRoids`.

## Ship

Run `npm run gate` before publication and again after review fixes. It includes static checks, runner contracts, the complete unit suite, production build and all server/entity integration tests. Code checks can overlap across worktrees; each checkout excludes overlapping validation. CI requires independent static, runner-contract and complete code-integration lanes to pass `CI / ci`. Browser suites and automatic frame-work/constrained-client gates are retired. Manual measurements remain outside the gate. Read [CI and local review](ci-and-local-review.md).

After merging, confirm Vercel's production Git deployment is READY at <https://www.georoids.com>. Classify server inputs with the classifier's `--changed` mode using the actual base and merge SHAs from the ship receipt. If the graph requires a server deployment, independently confirm Railway's production Git deployment succeeded; client success alone is insufficient. Successful host deployments establish the release. Do not compare served metadata or search bundle text for a commit SHA. Railway auto-deploys main. If deployment is absent or red, inspect the actual trigger and staged platform changes before any pinned-commit fallback; never upload an arbitrary local tree as a production release.

Read `/ship`'s installed deploy and smoke references for the canonical follower invocation. The Production smoke receipt uses `releaseSha` and `requestId` to identify the checked-out scenario and verification request. The runner checks the build-generated `client-assets.json` module graph, gameplay entry reachability, declared asset availability, HTTP health and a genuine current-protocol WebSocket pilot. Preserve healthy persistent-worker state, zero game-loop stalls, protocol admission, authoritative snapshots, movement and a correlated accepted-shot acknowledgement. It does not compare client/server release metadata or certify browser rendering, keyboard/touch controls, graphics or audio.

Manual production smoke requires a full `PRODUCTION_SMOKE_RELEASE_SHA` and unique `PRODUCTION_SMOKE_REQUEST_ID` to select the scenario checkout and correlate its receipt. Use the workflow dispatch inputs `release_sha` and `request_id`. The production runner starts no local server. After a new Railway deployment, follow a fresh smoke. Skipped, cancelled, missing, failed or timed-out smoke remains unverified. Artifacts retain HTTP/assets and protocol observations, descriptive release metadata, accepted-shot evidence, persistence health and owned-pilot cleanup.

Open clients check the static same-origin `release.json` for the full build identity, confirm a changed identity twice and retain a per-loaded-build refresh guard. This product refresh behavior is distinct from host deployment proof. `release.json` is served with `Cache-Control: no-store`. Astro emits static documents at `dist/index.html`, `dist/debug/index.html` and `dist/wiki/index.html`; `/debug` and `/wiki` also accept trailing slashes and retain query parameters. No route-rewrite middleware or client router is required.

## Deploy

Two separate deploy targets — client and server do not share a host.

### Vercel (static client)

| | |
| --- | --- |
| **Project** | `georoids` (`jsollys-projects`) |
| **Production URLs** | **Canonical:** <https://www.georoids.com>; **apex:** <https://georoids.com> (redirects to www); **Vercel default:** `https://georoids-jsollys-projects.vercel.app` |
| **Build** | `npm run build` → `dist/` (Astro static output; Vite is managed by Astro) |
| **Trigger** | Merge to `main` after the pre-commit gate and PR CI; Vercel GitHub integration. Branch pushes do **not** create Preview deployments (`vercel.json` `git.deploymentEnabled`); GeoRoids has no Preview path. |
| **Local deploy** | None — no `npm run deploy` or CLI deploy step from `/ship` |

**Required Vercel production env vars:**

| Variable | Purpose |
| --- | --- |
| `VITE_WEBSOCKET_URL` | WebSocket endpoint baked into the client at build time. Currently `wss://georoids-production-2403.up.railway.app/ws`. Must match the live Railway public URL + `/ws`. |

`VITE_BUILD_TIME`, short `VITE_COMMIT_HASH` and full `VITE_COMMIT_SHA` are injected by `scripts/client-build.ts` through `astro.config.ts` at build time — do not set them on Vercel. Only those metadata values and the required `VITE_WEBSOCKET_URL` are exposed to client code. The commit is the first valid 40-character SHA from `VERCEL_GIT_COMMIT_SHA`, then `RAILWAY_GIT_COMMIT_SHA`, then local Git. Empty hosted values do not block the later fallbacks. When host and local Git metadata are unavailable or invalid, the build generates one opaque 40-character hexadecimal token shared by the client and `release.json`. Version metadata never blocks a build.

Local dev: `npm run dev` sets an empty `VITE_WEBSOCKET_URL` so `ConnectionManager` uses same-origin `/ws`. Astro's Vite configuration proxies `/ws` and `/logs` to the configured local game-server port. This also supports phones using a public HTTPS tunnel to the Astro port. Direct `astro dev` runs can override the endpoint in `.env.local` (see `.env.example`).

### Railway (game server)

| | |
| --- | --- |
| **Config** | `.railway/railway.ts` (Railpack, `node --import tsx server.ts`, healthcheck `/health`) |
| **Public URL** | `https://georoids-production-2403.up.railway.app` (WebSocket: `wss://georoids-production-2403.up.railway.app/ws`) |
| **Deploy** | GitHub auto-deploy from `main` is enabled (API verified 2026-09-24; #704 deployed automatically). Confirm the production Git deployment succeeded. If no deployment arrives, inspect the trigger and use a pinned `commitSha` fallback only when it does not apply unrelated staged patches. |
| **Server release verification** | Use `scripts/server-release-inputs.mjs` to classify changes, including server-consumed modules under `src/` and runtime/build manifests. |

Railpack installs dependencies and runs `npm run build` during the build. The
tracked [`.railway/railway.ts`](../.railway/railway.ts) keeps the explicit
`startCommand` on Node with the installed `tsx` loader so the server owns
shutdown signals; restarts do not install packages or start the Astro development client.
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

Smoke: `curl -i https://georoids-production-2403.up.railway.app/health`. The server exposes `RAILWAY_GIT_COMMIT_SHA` in health JSON `releaseId` for diagnostics; host deployment status and gameplay smoke establish production verification.

The former `geoasteroids-production-2403.up.railway.app` hostname returns a Railway edge 404. Use the current `georoids-production-2403.up.railway.app` host for client configuration and verification.

## Commands

Use `npm run dev` for live rebuilding. The former `npm run watch` build command is retired because Astro does not support watched static builds.

```shell
# Dev (Astro on :5173 + ws server on :3001 via concurrently)
npm run dev                # ./scripts/dev-server.sh
npm run dev:check          # status of dev servers
npm run dev:kill           # stop only this checkout's owned dev session

# Build / typecheck / lint
npm run build              # Wiki checks + strict tsc + Astro build + built route/release/asset checks
npm run check:ts           # strict client/server/shared TypeScript
npm run check:frontend     # Astro and Svelte diagnostics; warnings fail
npm run check:format       # pinned Prettier checks Astro/Svelte formats
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

# Diagnostics / performance
npm run --silent logs -- --player <id>   # merged client/server timeline
npm run benchmark          # see benchmarks/README.md

```

Testing instructions, code-test commands, runner ownership and basic manual
browser smoke policy live in [tests/AGENTS.md](../tests/AGENTS.md).

## Architecture

### Two processes, one game

- **Client** (`src/`, served and built by Astro with Vite): rendering, input, prediction, HUD. Static game and debug routes share `src/components/GameDocument.astro` → `src/components/game/GameShell.svelte` → `src/runtime/gameRuntime.ts`, which composes an injected `EventLoop` and bootstraps `GameController` (singleton) which wires `GameStateManager`, `PlayerManager`, `InputManager`, `NetworkManager`, `CollisionManager`.
- **Server** (`server.ts` → `server/`): authoritative game loop. `GameEngine` owns world state via `EntityManager`, `AsteroidManager`, deterministic `RNGService`. `WebSocketCore` (`server/communication/`) routes messages through `MessageHandler`. `GameStateBroadcaster` periodically pushes state.
- **Two WebSocket paths on the same server**: `/ws` for gameplay, `/logs` for forwarded client logs (`ClientLogger` writes them to `logs/client.log`). HTTP routes on the same port: `/health`, `/status` (HTML or JSON depending on Accept/UA), `/test-server-log` (development/test only).

The Svelte shell owns the start screen, preferences, inventory, store, furnace travel, map controls, touch actions, field hints, network banners and diagnostics, including their responsive dialogs. It imports the browser-only runtime after mounting; initialization failure offers Retry and never queues Enter Game. The command port delegates to gameplay operations, while frozen presentation values update at most ten times per second and semantic transitions publish immediately. Canvas dimensions and pixels remain engine-owned; a separate geometry callback places shell controls. TypeScript painters receive explicit canvas elements from Svelte; the shell owns DOM state and styles. Map and touch adapters own their scoped gestures, while bounded presentation snapshots carry only visible controls and diagnostic values. Teardown retires the runtime, subscriptions, listeners, timers, painters, and owned connections. No legacy migration hosts remain. Renderer unit suites share only a canvas and safe-area probe; DOM scenarios mount the real Svelte components.

Astro's Vite development server proxies `/ws` and `/logs` to the owned local game-server port, normally `3001`, so the client connects through the Astro origin. The Wiki route is a separate Svelte-enhanced static manual and does not initialize the game; see [Wiki maintenance](wiki-maintenance.md).

Gameplay requires snapshot v3 and asteroid interactions. The client adds
`snapshotVersion=3` and `asteroidInteractions=1` to the WebSocket URL and sends both capabilities at join.
Unsupported clients receive HTTP 426 or an explicit join error; there are no
protocol opt-out flags or older-version bridge. Client and server deploy independently;
joining can be unavailable until both hosts publish matching versions. Reconnects
use a private resume token. See [snapshot deployment](protocol/snapshot-v3.md#deployment).

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
- `src/core/eventLoop.ts` — injected render/update loop with owned RAF and visibility/start listeners; `dispose()` cancels its work and removes those listeners. `src/runtime/gameRuntime.ts` owns browser startup and the production HUD callback.
- `src/entities/{player,ship,roid,laser,satellite,satellitePickup,loot}/` — entity classes and their managers/renderers. Ship motion and combat live in `Ship.ts` and its ship helpers.
- `src/physics/collision/{CollisionManager,collisionDetection}.ts` — collision system.
- `src/network/networkManager.ts` + `services/ConnectionManager.ts` — WS lifecycle, reconnection, message dispatch.
- `src/rendering/{canvas,boundaryRenderer,hud/}` — canvas + HUD; `GameController.renderGame` calls `canvasManager.drawGame`.
- `src/input/{PlayerInput,MockPlayerInput,mouse}.ts` — input abstraction; `MockPlayerInput` is what tests drive.
- `src/constants/index.ts` — single source of truth for tuning, `LOGGING`, and `DEBUG` flags.

### Debug & logging

For client diagnostics, visit `/debug`; add `?log-level=debug` for verbose client
logs, or `?log-level=info` or `?log-level=warn` to select a quieter threshold.
The normal `/` page uses Info and never remembers debug mode.

Simulation debug overrides remain compile-time constants, not URL or environment
settings. Set both `DEBUG.ENABLED = true` and
`LOGGING.GLOBAL_LOG_LEVEL = 'debug'` in `src/constants/index.ts` when those
local world overrides are needed. That global constant gates simulation debug
behavior; it does not select client log verbosity.

Notable flags under `DEBUG.*`: `ROIDS.{INITIAL_COUNT,MOVEMENT,PLACE_ON_LOCAL_PLAYER}`, `PLACE_PLAYERS_NEAR_BOUNDARY`. Client logs forward over `/logs` to the server; both ends append to:

- `logs/client.log` — client-side (forwarded over WS)
- `logs/server.log` — server-side

Logs are structured JSONL. Use `npm run --silent logs -- --player <id>` to merge a player's client/server timeline. Browser warnings, errors and correlated lifecycle `STATE` records also reach Railway's searchable logs. See [docs/diagnostics.md](diagnostics.md) for correlation, filtering, loss counters and profiling the actual game loop.

## Local development

- **Validation admission:** testing concurrency, ownership and cleanup rules live in [tests/AGENTS.md](../tests/AGENTS.md#run-and-report).
- **Manual measurement queue:** browser benchmark runner modes and direct frame measurements use one heavyweight FIFO slot in the common Git directory. Queue waits are visible and cancellable and precede execution deadlines. Failed ownership inspection preserves evidence; never delete a live allocator's lock.
- **Ports:** manual benchmark harnesses select distinct Astro client, server and proxy ports and support diagnostic `GEOROIDS_TEST_VITE_PORT`, `GEOROIDS_TEST_SERVER_PORT` and `GEOROIDS_TEST_PROXY_PORT` overrides. Their startup checks listener ownership and refuses occupied ports. Interactive development retains its defaults.
- **Node:** `package.json` requires `^24.15.0` (jsdom's Node 24 floor); `.nvmrc` is `24`.
- **`.env`:** an empty `.env` file must exist at the repo root (server startup uses `--env-file=.env`); create one with `touch .env` if missing.
- **`canvas` native deps:** the `canvas` npm package needs Cairo, Pango, libjpeg, libgif, and librsvg dev headers installed on the system.
- **Playwright browsers** (manual benchmarks and Wiki media only): install the browser required by that tool with `npx --no-install playwright install chromium`. Browser binaries are not needed for code-test validation. Preserve owned media and measurement outputs; these tools remain outside the gate.

### Local playground

`npm run dev` automatically enables `GEOROIDS_LOCAL_PLAYGROUND=1` in development.
Each server startup places all three tool pickups and all six satellite hulls
near Town Square and lights three first-band furnaces without replacing saved
player-built furnaces. New pilots start with 5,000 banked points; saved pilots
restored after a restart keep at least that amount. A live reconnect preserves
its current balance. Pickups use the ordinary collection and expiry rules.

Set `GEOROIDS_LOCAL_PLAYGROUND=0` before `npm run dev` to use the normal world.
Production never enables the preset, and integration runners' in-memory worlds
retain their scenario-owned fixtures.

### Services

| Service | Port | Health / URL |
| --- | --- | --- |
| Astro (client + `/ws` and `/logs` proxies) | 5173 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` → `200` |
| Game server (HTTP + WS) | 3001 | `curl http://localhost:3001/health` |

Start both with `npm run dev` (`./scripts/dev-server.sh`) for interactive development. The command refuses to attach to occupied ports; inspect the owner or choose isolated ports for the interactive session. The launcher keeps `astro dev --ignore-lock` in the foreground under its recorded process tree and owns both services, including content-triggered Astro restarts. Status: `npm run dev:check`. Stop: `npm run dev:kill`, which signals only the process tree recorded for this checkout. Code integration scenarios create their own port-zero loopback servers. Manual benchmark harnesses own separate configured service pairs and refuse occupied ports.

**Background dev:** `nohup npm run dev > /tmp/geo-dev.log 2>&1 &` works; tail `/tmp/geo-dev.log` for startup errors.

### Hello-world smoke

For basic manual browser smoke instructions, read [tests/AGENTS.md](../tests/AGENTS.md#basic-manual-browser-smoke).
