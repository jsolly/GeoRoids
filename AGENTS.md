# AGENTS.md

## Ship

Ship profile: `vercel-static`

**Integration: branch → PR → CI-gated auto-merge (canonical).** Open a PR from your branch; `.github/workflows/auto-merge.yml` squash-merges eligible owner/member PRs after **`CI / ci`** is success on the current head SHA. It does not arm GitHub `--auto` (that only waits for required checks, which this repo does not have). Direct push to `main` is break-glass only.

Production is split: **Vite static client on Vercel** + **WebSocket game server on Railway**. Merge to `main` only rebuilds the client. Server changes need a **separate Railway deploy** before multiplayer works in production.

Local gate before push: `npm run fix && npm run build` (full gate also runs in GitHub CI on the PR).

### Post-push verification (`/ship` step 12)

**Client-only changes** (default — `src/**`, client assets, docs, no server paths):

1. Wait for Vercel Git deployment READY (project `georoids`, team `jsollys-projects`).
2. `curl -sf -o /dev/null -w '%{http_code}\n' https://www.georoids.com` → `200`
3. Optional smoke: `<title>` is `GeoRoids` or page contains the Play button.
4. Record: `deploy: verified (Vercel Git)` at `https://www.georoids.com`

Do **not** curl `geoasteroids.com` — that domain is no longer registered (NXDOMAIN). The live client is **georoids.com**.

**Server changes** (`server.ts`, `server/**`, `railway.json`, or server-facing changes in `shared-types.ts`):

1. Complete client verification above if the push also touched client files.
2. Deploy manually on [Railway](https://railway.app) (linked GitHub repo or Railway CLI).
3. Smoke: `curl -sf https://geoasteroids-production.up.railway.app/health` (if the Railway public URL changed, update Vercel production `VITE_WEBSOCKET_URL` to `wss://<new-host>/ws` and redeploy the Vercel client).
4. Record: `deploy: verified (Vercel Git)` plus `Railway: deploy required` or `Railway: verified`.

Do not run `vercel deploy` from `/ship` unless Git integration is broken.

## Project

GeoAsteroids — a 2D multiplayer spaceship/asteroids game. Vite + TypeScript client (`src/`) talking to a Node WebSocket server (`server.ts` + `server/`) over `ws://`. Play the client at <https://www.georoids.com>; the authoritative server runs on Railway (see Deploy). Node `>=24`.

## Deploy

Two separate deploy targets — client and server do not share a host.

### Vercel (static client)

| | |
| --- | --- |
| **Project** | `georoids` (`jsollys-projects`) |
| **Production URLs** | **Canonical:** <https://www.georoids.com>; **apex:** <https://georoids.com> (redirects to www); **Vercel default:** `https://georoids-jsollys-projects.vercel.app` |
| **Build** | `npm run build` → `dist/` (Vite; framework auto-detected — no `vercel.json` required) |
| **Trigger** | Push to `main` after the pre-push gate; Vercel GitHub integration |
| **Local deploy** | None — no `npm run deploy` or CLI deploy step |

**Required Vercel production env vars:**

| Variable | Purpose |
| --- | --- |
| `VITE_WEBSOCKET_URL` | WebSocket endpoint baked into the client at build time. Currently `wss://geoasteroids-production.up.railway.app/ws`. Must match the live Railway public URL + `/ws`. |

`VITE_BUILD_TIME` and `VITE_COMMIT_HASH` are injected by `vite.config.ts` at build time — do not set on Vercel.

Local dev: `VITE_WEBSOCKET_URL=ws://localhost:3001/ws` in `.env.local` (see `.env.example`). Vite dev proxies `/ws` to `:3001` when unset; `ConnectionManager` falls back to same-origin `/ws`.

### Railway (game server)

| | |
| --- | --- |
| **Config** | `railway.json` (Nixpacks, `tsx server.ts`, healthcheck `/health`) |
| **Public URL** | `https://geoasteroids-production.up.railway.app` (WebSocket: `wss://geoasteroids-production.up.railway.app/ws`) |
| **Deploy** | Manual / separate from the Git push flow — Railway dashboard or CLI |
| **When required** | Changes under `server.ts`, `server/**`, `railway.json`, or server protocol changes in `shared-types.ts` |

Smoke: `curl https://geoasteroids-production.up.railway.app/health`

## CI (local pre-push gate)

- `.git-hooks/pre-push` (wired via `core.hooksPath=.git-hooks`, fires on push to `main`) runs dep grounding → lint → yaml → tsc → vitest. It does **not** deploy. After the push lands, babysit the Vercel GitHub deployment in the dashboard.

## Commands

```shell
# Dev (Vite on :5173 + ws server on :3001 via concurrently)
npm run dev                # ./scripts/dev-server.sh
npm run dev:check          # status of dev servers
npm run dev:kill           # kill all tsx/vite/concurrently processes

# Build / typecheck / lint
npm run build              # tsc && vite build
npm run check:ts           # tsc --noEmit
npm run check:lint         # biome check .
npm run check:fix          # biome check --write .
npm run fix                # biome write + tsc + unit tests

# Tests
npm run test               # unit only (tests/unit/)
npm run test:all           # everything (vitest run)
npm run test:integration:browser   # browser tests via test-runner.sh
npm run test:integration:server    # server-side integration
npm run test:integration:component # component integration

# Single test file (integration must use the runner script — not raw vitest)
./scripts/test-runner.sh tests/integration/browser/sanity/<file>.test.ts --reporter=verbose
npx vitest run tests/unit/path/to.test.ts        # OK for unit tests only
```

**Use `./scripts/test-runner.sh` for integration tests** — it enforces single-instance execution. Running `npx vitest` directly opens multiple Vitest forks, each spawning a WebSocket client to `:3001`, which hits the connection rate limiter and fails. The `vitest.config.ts` is hard-coded to `singleFork`, `concurrent: false`, `maxConcurrency: 1`, `fileParallelism: false`; keep those settings.

## Architecture

### Two processes, one game

- **Client** (`src/`, served by Vite): rendering, input, prediction, HUD. Entry is `index.html` → bootstraps `GameController` (singleton) which wires `GameStateManager`, `PlayerManager`, `InputManager`, `NetworkManager`, `CollisionManager`.
- **Server** (`server.ts` → `server/`): authoritative game loop. `GameEngine` owns world state via `EntityManager`, `AsteroidManager`, deterministic `RNGService`. `WebSocketCore` (`server/communication/`) routes messages through `MessageHandler`. `GameStateBroadcaster` periodically pushes state. Bots run server-side.
- **Two WebSocket paths on the same server**: `/ws` for gameplay, `/logs` for forwarded client logs (`ClientLogger` writes them to `logs/client.log`). HTTP routes on the same port: `/health`, `/status` (HTML or JSON depending on Accept/UA), `/test-server-log`.

Vite dev proxies `/ws` to `ws://localhost:3001` so the client always connects via the Vite origin.

### Server-authoritative model

Asteroids and bots live on the server; clients render snapshots. Clients still simulate their local ship for responsiveness. `playerNetwork.ts` and `network/networkManager.ts` handle outbound (input/shoot) and inbound (state) messages. Shared message/payload types live in `shared-types.ts` (top level, imported by both client and server).

### Key client modules

- `src/core/gameController.ts` — top-level lifecycle (`newGame`, `startGame`, `setupNetworkDisconnectionHandler`).
- `src/core/eventLoop.ts` — render/update loop.
- `src/entities/{player,ship,roid,laser,bot}/` — entity classes + per-entity managers/renderers. `ShipMovementManager` and `ShipCombatManager` split ship behavior.
- `src/physics/collision/{CollisionManager,collisionDetection}.ts` — collision system.
- `src/network/networkManager.ts` + `services/ConnectionManager.ts` — WS lifecycle, reconnection, message dispatch.
- `src/rendering/{RenderEngine,canvas,boundaryRenderer,hud/}` — canvas + HUD.
- `src/input/{PlayerInput,MockPlayerInput,mouse}.ts` — input abstraction; `MockPlayerInput` is what tests drive.
- `src/constants/index.ts` — single source of truth for tuning, `LOGGING`, and `DEBUG` flags.

### Debug & logging

Debug behavior is **constants, not env vars**. To enable debug mode, edit `src/constants/index.ts`:

1. `LOGGING.GLOBAL_LOG_LEVEL = 'debug'`
2. `DEBUG.ENABLED = true`

Notable flags under `DEBUG.*`: `LOCAL_PLAYER.INVINCIBLE`, `BOT_PLAYER.{COUNT,MOVEMENT,LASERS,SPAWN_PROTECTION}`, `ROIDS.{INITIAL_COUNT,MOVEMENT,PLACE_ON_BOT}`, `PLACE_PLAYERS_NEAR_CENTER`. Client logs forward over `/logs` to the server; both ends append to:

- `logs/client.log` — client-side (forwarded over WS)
- `logs/server.log` — server-side

Filter with grep prefixes: `[KEYBINDINGS]`, `[GAME_LOOP]`, `[RENDERING]`, `[NETWORK]`, `[SHIP]`, `[LASER]`, `[COLLISION]`, `[GAME_CONTROLLER]`. See `.cursor/rules/browser-integration-testing.mdc` for the full debugging playbook.

## Tests

- `tests/unit/` — pure, fast. Run via `npm run test`.
- `tests/integration/server/` — vitest against server modules directly.
- `tests/integration/component/` — vitest with jsdom against client modules.
- `tests/integration/browser/` — Selenium/Playwright driving a real browser. Organized by scenario: `sanity/`, `laser/`, `collision/`, `roid/`. **Name each test for the user scenario it describes**, not the function under test — e.g. `bots-explode-and-respawn-after-asteroid-collision.test.ts` (what happens) over `test-bot-collision.test.ts` (what's tested). Screenshots land in `tests/integration/browser/screenshots/`.

Integration tests boot the dev servers if not already running. If a test hangs or fails strangely, run `npm run dev:kill` then re-run.

## Project conventions

- **No barrel files / re-exports** — import from the defining module.
- **Relative paths only** — no `@`-style aliases.
- **Biome** is the only linter/formatter (`biome.jsonc`); ESLint is gone.
- **Singletons via `getInstance()`** for the top-level managers (`GameController`, `PlayerManager`, `CollisionManager`, etc.) — wire through these, don't `new` them.
- **Shared types** go in `shared-types.ts` at repo root, not duplicated per side.
- **Conventional Commits** (`feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `docs`) with a scope (e.g. `feat(network): ...`).
- **Scenario-style test names** — describe a real user/system event, not the function under test.

## Local development

- **Integration tests:** always `./scripts/test-runner.sh`, never raw `npx vitest` on `tests/integration/`.
- **Node:** `package.json` requires `>=24`; `.nvmrc` is `24`.
- **`.env`:** an empty `.env` file must exist at the repo root (server startup uses `--env-file=.env`); create one with `touch .env` if missing.
- **`canvas` native deps:** the `canvas` npm package needs Cairo, Pango, libjpeg, libgif, and librsvg dev headers installed on the system.
- **Playwright browsers** (browser E2E): `npx playwright install`. If the headless-shell binary is missing, remove the stale lock (`rm -f ~/.cache/ms-playwright/__dirlock`) and reinstall.

### Services

| Service | Port | Health / URL |
| --- | --- | --- |
| Vite (client + `/ws` proxy) | 5173 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` → `200` |
| Game server (HTTP + WS) | 3001 | `curl http://localhost:3001/health` |

Start both with `npm run dev` (`./scripts/dev-server.sh`). Status: `npm run dev:check`. Stop: `npm run dev:kill`. If integration tests hang or rate-limit, kill then restart dev before re-running `./scripts/test-runner.sh`.

**Background dev:** `nohup npm run dev > /tmp/geo-dev.log 2>&1 &` works; tail `/tmp/geo-dev.log` for startup errors.

### Lint / tests (reference)

See **Commands** above. Browser E2E must use `./scripts/test-runner.sh` (never raw `npx vitest` on `tests/integration/`).

### Hello-world smoke

With dev servers up: open `http://localhost:5173`, click Play, thrust (arrow keys) and fire (Space). Or run `./scripts/test-runner.sh tests/integration/browser/sanity/game-initializes-with-arena-and-hud.test.ts --reporter=verbose` — navigates to the game, clicks Play, and asserts canvas, HUD, and asteroids.

### Logs

`logs/client.log` and `logs/server.log` (see `.cursor/rules/log-files.mdc`). Enable verbose client logs in `src/constants/index.ts` (`LOGGING.GLOBAL_LOG_LEVEL`, `DEBUG.ENABLED`), not via env vars.

### Quick verification checklist

```bash
npm run check:lint   # biome check — should pass cleanly
npm run check:ts     # tsc --noEmit — should pass cleanly
npm run test         # unit tests (~3s)
npm run build        # tsc && vite build — produces dist/
```
