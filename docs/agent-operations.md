# Agent operations

Read root `AGENTS.md` for controls. This guide owns commands, deployment procedures and module orientation. Commands run from the GeoRoids repository root; the primary laptop checkout is `/Users/johnsolly/code/GeoRoids`.

## Ship

Run the complete gate before publication and after review fixes; [CI and local review](ci-and-local-review.md#local-review) owns its stages and evidence requirements.

After merging, confirm Vercel's production Git deployment is READY at <https://www.georoids.com>. Classify server inputs with the classifier's `--changed` mode using the actual base and merge SHAs from the ship receipt. If the graph requires a server deployment, independently confirm Railway's production Git deployment succeeded; client success alone is insufficient. Successful host deployments establish the release. Do not compare served metadata or search bundle text for a commit SHA. Railway auto-deploys main. If deployment is absent or red, inspect the actual trigger and staged platform changes before any pinned-commit fallback; never upload an arbitrary local tree as a production release.

Follow the repository-owned Production smoke workflow and inspect its exact-release receipt; optional personal release helpers are not prerequisites. The Production smoke receipt uses `releaseSha` and `requestId` to identify the checked-out scenario and verification request. The runner checks the build-generated `client-assets.json` module graph, gameplay entry reachability, declared asset availability, HTTP health and a genuine current-protocol WebSocket pilot. Preserve healthy persistent-worker state, zero game-loop stalls, protocol admission, authoritative snapshots, movement and a correlated accepted-shot acknowledgement. It does not compare client/server release metadata or certify browser rendering, keyboard/touch controls, graphics or audio.

Manual production smoke requires a full `PRODUCTION_SMOKE_RELEASE_SHA` and unique `PRODUCTION_SMOKE_REQUEST_ID` to select the scenario checkout and correlate its receipt. Use the workflow dispatch inputs `release_sha` and `request_id`. The production runner starts no local server. After a new Railway deployment, follow a fresh smoke. Skipped, cancelled, missing, failed or timed-out smoke remains unverified. Artifacts retain HTTP/assets and protocol observations, descriptive release metadata, accepted-shot evidence, persistence health and owned-pilot cleanup.

Open clients compare their embedded full build identity with static same-origin
`release.json`, served with `Cache-Control: no-store`. The game, debug page and
Wiki share a shell-owned notice, with no service worker. Successful checks require
JSON content type, the expected schema and a final same-origin URL; errors,
redirects, malformed data and offline responses never indicate an update. Two
matching observations confirm each different release, including rollbacks.

The foreground timer uses a thirty-second cadence with twenty-percent jitter,
chosen to surface game protocol releases promptly. Failures back off to at most
six minutes. Hidden/offline tabs stop the timer and abort pending requests;
visible return, focus and reconnect trigger coalesced, throttled checks. A failed
check preserves an already confirmed notice. Later dismisses only that target
in this document; Update available reopens it, and another confirmed release
announces again. There are no cross-tab reload messages.

Update and reload opens the session/unfinished-input confirmation. Cancel keeps
the flight and input; the game continues while the prompt is open. After consent,
a fresh online metadata check must still match the target before this tab reloads
once. A third release, failed check, blocked tab recovery storage or cancellation
keeps the page usable and offers retry. Application suspends polling, owns an
abort signal and is cancelled by dismissal, page hide or unmount, so late results
cannot overwrite a later attempt. A per-tab attempt marker detects stale HTML
after reload and explains manual retry; a newer loaded build clears the marker.
No update path clears unrelated storage or caches.

Migration: clients already running the prior automatic-refresh implementation
retain it until they load this release. The new implementation never reloads
from polling. Production deployment status and the canonical smoke remain
separate release proof; the notice is a product feature.

Astro emits content-addressed JS/CSS and atomically published static documents at
`dist/index.html`, `dist/debug/index.html` and `dist/wiki/index.html`. The game
imports its runtime immediately on mount; the Wiki's chart code is in its initial
module graph. Audio (`howler`) and client log forwarding still import chunks on
demand. Generated JS/CSS now uses `/_vercel/immutable/<salt-digest>/` URLs.
`scripts/build-vercel-output.mjs` emits Vercel's Build Output API static tree and
full SHA-256 immutable manifest. The provider serves these files across deployments
even when the current build omits them, including overlapping builds. No service
worker or previous-build cache is required; documents and release metadata stay current.

Retain availability for at least 30 days. The provider exposes no expiry field in
this manifest, so files may remain longer. Do not rotate `VERCEL_HASH_SALT`, remove
retention routing, delete historical deployments or promote pre-migration outputs
during this window. Supported rollbacks rebuild Git main with retention intact.
This protects asset loading, not compatibility with a newer server protocol.

The migration inventory in `scripts/legacy-client-assets.json` pins all 13 generated
JS/CSS assets of production `c45e47bd281684f6ff94e89ff4c61a545967bba9`.
Exact `/_astro/` aliases route these original URLs to the shared immutable registry.
Production builds verify existing registry bytes, bootstrapping only missing entries
from the pinned first-party deployment; errors or checksum changes fail the build.
Local, CI and Railway builds make no migration network requests. Older releases
outside this inventory have no retroactive availability guarantee. Mutable public
media is outside the generated-chunk contract.

To verify native retention across two completed production deployments, capture
the current canonical asset bytes before the next merge:

```sh
node scripts/verify-retained-assets.mjs capture /tmp/georoids-assets-before.json
```

After the newer Vercel Git deployment is READY, verify the original URLs:

```sh
node scripts/verify-retained-assets.mjs verify /tmp/georoids-assets-before.json /tmp/georoids-retention-proof.json
```

The checker requires at least one captured URL absent from the newer complete
`immutable-assets.json` output inventory, then verifies every original URL's size,
SHA-256 and content type with cache bypassed. Identical inventory reads bracket the
downloads; a deployment changing during verification fails. Capture likewise rejects
a changing document/module inventory. Keep the completed host deployment receipts
with this evidence. This proves initial cross-deployment availability, not the
passage of 30 days, browser rendering or legacy migration; verify legacy aliases
against their separate pinned inventory. The public inventory is generated from the
exact native manifest and served with `Cache-Control: no-store`.

The repo adapts the merged website-update contract from dotagents
`f861d7c961a7bb1e6229d4565b7c787d91279e1c` in these instructions and code tests;
there is no runtime/build dependency on that repository. Manual browser evidence
follows `tests/AGENTS.md`, rather than adding an automated browser suite. `/debug`
and `/wiki` also accept trailing slashes and retain query parameters; ordinary
document navigation needs no rewrite middleware or client router.

## Deploy

Two separate production deploy targets — client and server do not share a host. The opt-in [Railway preview](#railway-preview) is the one same-origin exception.

### Vercel (static client)

| | |
| --- | --- |
| **Project** | `georoids` (`jsollys-projects`) |
| **Production URLs** | **Canonical:** <https://www.georoids.com>; **apex:** <https://georoids.com> (redirects to www); **Vercel default:** `https://georoids-jsollys-projects.vercel.app` |
| **Build** | `npm run build` → `dist/` for local/Railway serving, plus `.vercel/output/` with static files, routes and the shared immutable manifest for Vercel. Astro manages Vite. |
| **Trigger** | Merge to `main` after the pre-commit gate and PR CI; Vercel GitHub integration. Branch pushes do **not** create Preview deployments (`vercel.json` `git.deploymentEnabled`); Vercel is production-only. The opt-in preview path is the [Railway preview](#railway-preview). |
| **Local deploy** | None — no `npm run deploy` or CLI deploy step in the release process |

**Required Vercel production env vars:**

| Variable | Purpose |
| --- | --- |
| `VITE_WEBSOCKET_URL` | WebSocket endpoint baked into the client at build time. Currently `wss://georoids-production-2403.up.railway.app/ws`. Must match the live Railway public URL + `/ws`. |

`VITE_BUILD_TIME` and full `VITE_COMMIT_SHA` are injected by `scripts/client-build.ts` through `config/app/astro.ts` at build time — do not set them on Vercel. Only those metadata values and the required `VITE_WEBSOCKET_URL` are exposed to client code. The commit is the first valid 40-character SHA from `VERCEL_GIT_COMMIT_SHA`, then `RAILWAY_GIT_COMMIT_SHA`, then local Git. Empty hosted values do not block the later fallbacks. When host and local Git metadata are unavailable or invalid, the build generates one opaque 40-character hexadecimal token shared by the client and `release.json`. Version metadata never blocks a build. The visible build label takes its first seven characters from that same validated identity.

Local dev: `npm run dev` sets an empty `VITE_WEBSOCKET_URL` so `ConnectionManager` uses same-origin `/ws`. Astro's Vite configuration proxies `/ws`, `/logs` and `/debug-reports` to the configured local game-server port. Direct `astro dev --config config/app/astro.ts` runs can override the endpoint in `.env.local` (see `config/app/.env.example`). Report submissions allow the documented local origins; other tunnel origins are rejected; use a documented loopback origin or the configured Railway public domain for reporting.

### Railway (game server)

| | |
| --- | --- |
| **Config** | `.railway/railway.ts` (Railpack, `node --import tsx server.ts`, healthcheck `/health`) |
| **Public URL** | `https://georoids-production-2403.up.railway.app` (WebSocket: `wss://georoids-production-2403.up.railway.app/ws`) |
| **Deploy** | GitHub auto-deploy from `main` is enabled (API verified 2026-09-24; #704 deployed automatically). Confirm the production Git deployment succeeded. If no deployment arrives, inspect the trigger and use a pinned `commitSha` fallback only when it does not apply unrelated staged patches. |
| **Server release verification** | Use `scripts/server-release-inputs.mjs` to classify changes to `server/`, `shared/`, `setup/`, `.railway/`, `server.ts`, `shared-types.ts` and runtime/build manifests. It fails when any of those modules imports `src/`, so client-only changes never need a server release. |

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

Smoke: `curl -i https://georoids-production-2403.up.railway.app/health`. The player count is `world.players`, alongside `world.loop` and `world.persistence`; `/status` reads that same count. The server exposes `RAILWAY_GIT_COMMIT_SHA` in health JSON `releaseId` for diagnostics; host deployment status and gameplay smoke establish production verification.

The former `geoasteroids-production-2403.up.railway.app` hostname returns a Railway edge 404. Use the current `georoids-production-2403.up.railway.app` host for client configuration and verification.

### Railway preview

One shared Railway environment, `preview`, runs a pull request's server **and** serves its built client from the same origin, so the client's same-origin `/ws` reaches the matching server. Use it to play a change before merge. It is never release evidence.

| | |
| --- | --- |
| **Trigger** | An owner, member or collaborator with repository write access comments `/preview` (alone on the first non-empty line) on an open same-repo PR. The resolver checks the comment author's current repository permission through GitHub's API; `write` and `admin` pass, including maintain access reported as `write`. Missing, unreadable or lower permissions reject the request before deployment. Only the repository owner can dispatch `Railway Preview` with a PR number or rerun a request. Agents never comment `/preview` or dispatch `Railway Preview` unless John asks. |
| **Deploy** | `.github/workflows/railway-preview.yml` resolves the request in a job without secrets, then checks out the PR head, refuses symlinks, removes `.railway/`, stamps `public/preview-release.txt` with the head SHA, and runs `railway up --environment preview`. It installs nothing from the PR and executes no PR code. The pinned Railway CLI runs through `npm exec` from `$RUNNER_TEMP`, so no PR `.npmrc` applies. The PR comment carries the URL and SHA. Rejections, failures, timeouts and cancellations also comment; a request still queued when a newer `/preview` arrives is superseded without a comment. |
| **Slot** | One environment: the latest `/preview` on any PR replaces the deploy. New commits do not redeploy until someone comments `/preview` again. |
| **Server mode** | `GEOROIDS_PREVIEW_CLIENT=1` makes `server.ts` serve `dist/` through `server/staticClient.ts`; the exact server routes `/health`, `/status`, `/ws` and `/logs` keep precedence. The flag refuses to start unless `RAILWAY_ENVIRONMENT_NAME=preview`. `NODE_ENV` stays `production`, so rate limits stay on and test routes stay off, and the flag always disables the local playground. It is a deployment selector, like `GEOROIDS_LOCAL_PLAYGROUND`, rather than a second entrypoint, so preview and production share one startup, persistence guard and shutdown path. |
| **World** | The environment's own `world-data` volume at `/data`. Treat it as disposable. |
| **Credentials** | GitHub Environment `railway-preview` (deployment branches: `main`) holds `RAILWAY_TOKEN`, a Railway project token scoped to `preview`, plus `RAILWAY_PREVIEW_DOMAIN`. That token cannot deploy or configure production. |
| **Release identity** | Upload deploys carry no Git metadata, so `/health` `releaseId` is `dev` and `release.json` holds a per-build token. `/preview-release.txt` names the deployed head SHA; the workflow waits for exactly that SHA. |

One-time setup is human-owned production configuration:

1. Duplicate production into an environment named `preview` without copying variable values into source. Confirm its volume id differs from production's `world-data`, and that it has a Railway-provided domain on port 8080.
2. In `preview` only, set `GEOROIDS_PREVIEW_CLIENT=1`, disconnect its automatic deploys from `main`, enable app sleeping, and set a 1 GB memory limit.
3. Keep Railway's PR Environments and Bot PR Environments toggles off.
4. Create the `preview`-scoped project token and the GitHub Environment secrets above.

Never point this workflow at production, apply `.railway/railway.ts` to `preview`, or use a workspace or account token for it. Preview `deployment_status` events start `production-smoke.yml`, which skips them because its `if:` requires the production environment URL.

## Debug report operations

The **Debug reports** section already exists in Todoist project
`6hWp83X3jfHJpW8v`, section `6hmMfqqQ4rwgJFGv`. Runtime delivery requires
John to configure `TODOIST_API_TOKEN` as a Railway server secret for account
`17333018`, `todoist@jsolly.com`. The connected chat's Todoist login cannot
supply credentials to the running game. The worker verifies the account,
project and section before publishing. Do not expose the token through client
environment variables, logs or source. A personal API token grants access to
its account; protect and rotate it as a server credential.

`GEOROIDS_DEBUG_REPORTS_SECTION_ID` defaults to the verified section above.
`GEOROIDS_DEBUG_REPORTS_PATH` defaults beside `GEOROIDS_WORLD_PATH`, giving
`/data/debug-reports.sqlite` in production. It must be a separate database on
the mounted Railway volume. Include that file and its journals in volume
backup policy. `GEOROIDS_DEBUG_REPORTS_ENABLED=0` disables reporting without
changing gameplay. Local development uses ignored `.data/debug-reports.sqlite`.
Automated tests use explicit temporary stores, never the developer's queue.

Only the report worker parses, redacts and persists report bodies or contacts
Todoist. The main server accepts at most two concurrent uploads and eight
worker requests, with a ten-second request deadline. New reports are limited
to 2 MiB, three per client address per hour and 30 globally per UTC day.
These limits are independent of gameplay admission. Railway public HTTP
ingress supplies `X-Real-IP`; local development uses the socket address and
ignores forwarded address headers. Before release, verify that Railway replaces
client-supplied `X-Real-IP` values. Do not expose this reporting listener through
an untrusted internal proxy that can choose that header.

The report database has a 128 MiB main-file limit, a 16 MiB WAL safety limit,
and a 100 MiB or 200-report pending limit. New acceptance reserves at least
256 MiB free space for the world database. Full or unavailable storage rejects
new reports explicitly. Delivered payloads are reclaimed; minimal duplicate
and receipt records persist. Pending reports are never evicted.

`GET /health` includes aggregate `debugReports` counts, the oldest pending
timestamp and a safe delivery error. `pending` and `blocked` are null when the
depth is unknown rather than zero: before the worker's first report on a fresh
process, after a storage fault, and after a worker failure, which discards the
last measured depth because it can no longer be trusted. For those two counts,
null means unmeasured rather than drained, and only a number says the queue was
counted. `oldestPendingAt` is different: it is null when no undelivered report
is queued, which is the healthy steady state, and also null whenever the counts
are null, so it cannot be read as a depth signal on its own. Read the two counts
first, and the delivery error beside them when it is set. Reporting failure does not make gameplay
unhealthy. Credential, permission and Todoist project-capacity failures keep
reports blocked. Repair the credential or capacity and let the worker retry;
configuration changes require a service restart. Transient failures retry with
backoff and jitter, respecting Todoist's retry delay. Do not complete unrelated
tasks to make space. A caller can check only its own report state using the
receipt capability; there is no public report-content endpoint.

For release acceptance, submit one explicitly identified test report through
`/debug`, read the resulting task and all comment pages through the Todoist
connector, and verify the reconstructed UTF-8 size and SHA-256 against the
task manifest. Confirm **VERIFIED READY**, then record and close that test
report. This live test is separate from local loopback API tests and the normal
production smoke. Follow [diagnostic review](diagnostics.md#review-reports-as-an-agent)
for real reports. Agents do not configure production credentials or deploy
infrastructure.

## Commands

Use `npm run dev` for live rebuilding.

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
npm run check:lint         # Biome with config/quality/biome.settings.jsonc
npm run check:lint-policy  # reject inherited warn/info Biome severities
npm run check:knip         # fail on unused files/exports/dependencies and config hints
npm run check:ts-prune     # fail on unconsumed TypeScript exports
npm run check:members      # fail on public methods, fields and accessors nothing outside the declaring class reaches
npm run check:md           # markdownlint-cli2
npm run check:yaml         # yamllint --strict
npm run check:actions      # actionlint + ShellCheck
npm run check:fix          # Biome write with config/quality/biome.settings.jsonc
npm run fix                # biome write + tsc + unit tests
npm run check:wiki         # flag gameplay changes that need a Wiki review (runs in build)
npm run gate               # complete battery; see docs/ci-and-local-review.md

# Diagnostics / performance
npm run --silent logs -- --player <id>   # merged client/server timeline
npm run benchmark          # see benchmarks/README.md

```

Testing instructions, code-test commands, runner ownership and basic manual
browser smoke policy live in [tests/AGENTS.md](../tests/AGENTS.md).

## Architecture

### Two processes, one game

- **Client** (`src/`, served and built by Astro with Vite): rendering, input, prediction, HUD. Static game and debug routes share `src/components/GameDocument.astro` → `src/components/game/GameShell.svelte` → `src/runtime/gameRuntime.ts`, which composes an injected `EventLoop` and bootstraps `GameController` (singleton) which wires `GameStateManager`, `PlayerManager`, `InputManager`, `ConnectionManager`, `CollisionManager`.
- **Server** (`server.ts` → `server/`): authoritative game loop. `GameEngine` owns world state via `EntityManager`, `AsteroidManager`, deterministic `RNGService`. `WebSocketCore` (`server/communication/`) routes messages through `MessageHandler`. `GameStateBroadcaster` periodically pushes state.
- **Two WebSocket paths on the same server**: `/ws` for gameplay, `/logs` for forwarded client logs (`ClientLogger` writes them to `logs/client.log`). HTTP routes on the same port: `/health`, `/status` (HTML or JSON depending on Accept/UA), `/debug-reports` and capability-protected report status, `/test-server-log` (development/test only).

The Svelte shell owns the start screen, preferences, inventory, store, furnace travel, map controls, touch actions, field hints, network banners and diagnostics, including their responsive dialogs. It imports the browser-only runtime after mounting; initialization failure offers Retry and never queues Enter Game. The command port delegates to gameplay operations, while frozen presentation values update at most ten times per second and semantic transitions publish immediately. Canvas dimensions and pixels remain engine-owned; a separate geometry callback places shell controls. TypeScript painters receive explicit canvas elements from Svelte; the shell owns DOM state and styles. Map and touch adapters own their scoped gestures, while bounded presentation snapshots carry only visible controls and diagnostic values. Teardown retires the runtime, subscriptions, listeners, timers, painters, and owned connections. No legacy migration hosts remain. Renderer unit suites share only a canvas and safe-area probe; DOM scenarios mount the real Svelte components.

Astro's Vite development server proxies `/ws`, `/logs` and `/debug-reports` to the owned local game-server port, normally `3001`, so the client connects through the Astro origin. The Wiki route is a separate Svelte-enhanced static manual and does not initialize the game; see [Wiki maintenance](wiki-maintenance.md).

Gameplay requires snapshot v3 and asteroid interactions. The client adds
`snapshotVersion=3` and `asteroidInteractions=1` to the WebSocket URL and sends both capabilities at join.
Unsupported clients receive HTTP 426 or an explicit join error; there are no
protocol opt-out flags or older-version bridge. Client and server deploy independently;
joining can be unavailable until both hosts publish matching versions. Reconnects
use a private resume token. See [snapshot deployment](protocol/snapshot-v3.md#deployment).

### Server-authoritative model

Asteroids live on the server; clients render snapshots. Clients still simulate their local ship for responsiveness. `GameController` owns the wall-clock 60 Hz pose timer; `network/services/ConnectionManager.ts` owns outbound commands and inbound state. Shared message/payload types live in `shared-types.ts` (top level, imported by both client and server).

`shared/` holds the gameplay rules both sides must agree on (ship flight, combat, asteroid materials/reflection, furnaces, economy, exploration, world interest radii in `shared/world.ts`). Client prediction and the server simulation import the same module, so change a rule there once rather than mirroring it in `src/` and `server/`.

The injected slice covers EventLoop lifecycle, PlayerManager's
network port, and each Ship's combat capability. GameController creates the
production PlayerManager with ConnectionManager's capabilities;
authoritative snapshot creation passes that same connection's capability through
the factory to Player and Ship. Later singleton access cannot rebind an instance.
Other UI, world, rendering, telemetry, audio and network singleton entrypoints remain;
the tested independent graphs do not represent two complete games or sockets.

### Key client modules

- `src/core/gameController.ts` — top-level lifecycle (`newGame`, `startGame`, `setupNetworkDisconnectionHandler`).
- `src/core/eventLoop.ts` — injected render/update loop with owned RAF and visibility/start listeners; `dispose()` cancels its work and removes those listeners. `src/runtime/gameRuntime.ts` owns browser startup and the production HUD callback.
- `src/entities/{player,ship,roid,laser,satellite,satellitePickup,loot}/` — entity classes and their managers/renderers. Ship motion and combat live in `Ship.ts` and its ship helpers.
- `src/physics/CollisionManager.ts` — client collision system; boundary checks live in `shared/boundary.ts`.
- `src/network/services/ConnectionManager.ts` — WS lifecycle, reconnection, message dispatch.

- `src/rendering/{canvas,boundaryRenderer,hud/}` — canvas + HUD; `GameController.renderGame` calls `canvasManager.drawGame`.
- `src/input/{keybindings,mouse,touchControls,controlSources}.ts` — input sources; `reconcilePlayerInput` applies controls to the local ship.
- `shared/constants/gameplay.ts` — gameplay tuning both sides enforce (`GAME`, `SHIP`, `LASER`, `ROID`, deposits, pickups, snapshot colours).
- `src/constants/index.ts` — client presentation tuning (`VISUAL`, `PALETTE`, `TOUCH`, `AUDIO`) and `LOGGING`.

### Debug & logging

For client diagnostics, visit `/debug`; add `?log-level=debug` for verbose client
logs, or `?log-level=info` or `?log-level=warn` to select a quieter threshold.
The normal `/` page uses Info and never remembers debug mode.

Client logs forward over `/logs` to the server; both ends append to:

- `logs/client.log` — client-side (forwarded over WS)
- `logs/server.log` — server-side

Logs are structured JSONL. Use `npm run --silent logs -- --player <id>` to merge a player's client/server timeline. Browser warnings, errors and correlated lifecycle `STATE` records also reach Railway's searchable logs. See [docs/diagnostics.md](diagnostics.md) for correlation, filtering, loss counters and profiling the actual game loop.

## Local development

- **Validation admission:** testing concurrency, ownership and cleanup rules live in [tests/AGENTS.md](../tests/AGENTS.md#run-and-report).
- **Manual measurement queue:** browser benchmark runner modes and direct frame measurements use one heavyweight FIFO slot in the common Git directory. Queue waits are visible and cancellable and precede execution deadlines. Failed ownership inspection preserves evidence; never delete a live allocator's lock.
- **Ports:** manual benchmark harnesses select distinct Astro client, server and proxy ports and support diagnostic `GEOROIDS_TEST_VITE_PORT`, `GEOROIDS_TEST_SERVER_PORT` and `GEOROIDS_TEST_PROXY_PORT` overrides. Their startup checks listener ownership and refuses occupied ports. Interactive development retains its defaults.
- **Node:** `package.json` requires `^24.15.0` (jsdom's Node 24 floor); `.nvmrc` is `24`.
- **TypeScript:** code checks and server release classification use `scripts/typescript-cli.mjs` to select the TypeScript 7 native CLI. Astro, Svelte and unused-export tooling import the supported TypeScript 6 API through the `typescript` compatibility alias. Use the package scripts: both compiler packages expose `tsc`, so `node_modules/.bin/tsc` does not identify which compiler runs.
- **Environment:** `npm run dev` copies `config/app/.env.example` to `.env.local` when missing; the server loads it with `--env-file=.env.local`. A missing or unreadable example fails startup.
- **`canvas` native deps:** the `canvas` npm package needs Cairo, Pango, libjpeg, libgif, and librsvg dev headers installed on the system.
- **Playwright browsers** (manual benchmarks only): install the browser required by that tool with `npx --no-install playwright install chromium`. Browser binaries are not needed for code-test validation. Preserve owned media and measurement outputs; these tools remain outside the gate.
- **Wiki media:** node-canvas and Python with the pin in `scripts/wiki-media-requirements.txt` render demonstrations. Set `WIKI_MEDIA_PYTHON` to the prepared Python executable; browser binaries are unnecessary.

### Cloud sessions

Claude Code cloud containers start on an image Node and without dependencies. When a session is rooted above the repository (multi-repo sessions), the repo's SessionStart hook does not run. Bootstrap from the repository root:

```shell
bash .cursor/install-app.sh        # native libraries, pinned mise tools, npm ci, .env
mise exec -- node --version        # v24.x
mise exec -- npm run gate
```

For a brief manual smoke ([tests/AGENTS.md](../tests/AGENTS.md#basic-manual-browser-smoke)):

1. Start `mise exec -- npm run dev` in the background.
2. Wait for `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/` to return `200` and `curl http://127.0.0.1:3001/health` to answer.
3. Open the affected route with the session's browser controls and exercise the changed control or a brief join/steer/fire flow. Check console and page errors. For layout changes, inspect desktop and mobile widths and attach both screenshots; report the routes, interactions, errors and observed result.
4. If the repository's pinned Playwright expects a different browser revision than `/opt/pw-browsers`, use the image's preinstalled Playwright from a scratch directory, never as a package script. Wait for the game canvas rather than a fixed delay. Report missing browser access as unverified. Personal skills may help with the check but are not a bootstrap requirement.
5. Stop with `mise exec -- npm run dev:kill`.

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

Browser identity uses `crypto.randomUUID()` and requires HTTPS or a localhost secure context.

Start both with `npm run dev` (`./scripts/dev-server.sh`) for interactive development. The command refuses to attach to occupied ports; inspect the owner or choose isolated ports for the interactive session. The launcher keeps `astro dev --config config/app/astro.ts --ignore-lock` in the foreground under its recorded process tree and owns both services, including content-triggered Astro restarts. Status: `npm run dev:check`. Stop: `npm run dev:kill`, which signals only the process tree recorded for this checkout. Code integration scenarios create their own port-zero loopback servers. Manual benchmark harnesses own separate configured service pairs and refuse occupied ports.

Development-session ownership reads the target PID's working directory directly
from procfs with `readlink` on Linux and with `lsof` elsewhere. An inspection error
refuses signaling or metadata replacement; it never switches to another backend.

**Background dev:** `nohup npm run dev > /tmp/geo-dev.log 2>&1 &` works; tail `/tmp/geo-dev.log` for startup errors.

### Hello-world smoke

For basic manual browser smoke instructions, read [tests/AGENTS.md](../tests/AGENTS.md#basic-manual-browser-smoke).
