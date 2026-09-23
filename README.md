# GeoRoids

A cooperative open-world spaceship game with surveying, asteroid towing, and shared mineral deliveries. Play at [www.georoids.com](https://www.georoids.com).

The Vite + TypeScript client renders and predicts the local ship. A Node WebSocket server owns the shared world, combat, asteroid field, NPCs and rewards.

## Local development

Use Node 24.15 or newer within major 24 (`nvm use`). The jsdom test environment requires this patch-level floor. On macOS, the native `canvas` dependency requires Cairo, Pango, libjpeg, giflib and librsvg.

```sh
git clone git@github.com:jsolly/GeoRoids.git
cd GeoRoids
npm ci
touch .env
npm run dev
```

Vite serves the client at `http://localhost:5173`; the game server listens on port 3001. `npm run dev` routes `/ws` and `/logs` through the Vite origin to the local server, including custom dev ports. A public HTTPS tunnel to Vite therefore also carries the game WebSocket, so phones never connect to their own `localhost`. Direct Vite and production endpoint configuration is documented in `.env.example`.

Choose a ship, enter the game, steer with the mouse or left/right arrow keys while thrust stays on, Space to fire, E to scan as Scout or attach/release cargo as Hauler. Mobile players use the on-screen controls. The minimap follows your ship through the 120,000-unit-wide world. Shared fog records discoveries; Scouts reveal more terrain, and discovered furnaces remain marked.

Every player belongs to the crew. Direct crew lasers pass through ships; a bounced shot becomes a ricochet that can hurt you or another pilot. Tow a scanned asteroid into a furnace to give both the Hauler and its Scouts the full reward, including Scouts who are offline.

Reflective asteroid clusters can bounce lasers and release laser-core upgrades. The [asteroid interactions guide](docs/asteroid-interactions.md) covers reflection, core charges and the shared snapshot behavior.

## Field manual

The companion player manual is built at `/wiki/` on the same client origin. It covers ship abilities and game mechanics with searchable articles, a ship comparison, and playable GIF demonstrations. The game title screen links to it.

See [manual maintenance](docs/wiki-maintenance.md) for content, reproducible media generation, and the source-review gate, and [coverage](docs/wiki-coverage.md) for the mechanic inventory. `npm run check:wiki` is part of the production build and flags gameplay changes that need a documentation review.

## Verification

Run commands from the repository directory:

```sh
npm run gate
npm run test
npm run test:integration:server
npm run test:integration:browser
```

`npm run gate` checks dependencies, lint, configuration, TypeScript, unit tests and the production build. Browser tests need the pinned Playwright browser installation (`npx --no-install playwright install chromium webkit`). Always use `./scripts/test-runner.sh` for individual integration scenarios; it enforces serialized execution.

Test-writing conventions are in [tests/AGENTS.ms](tests/AGENTS.ms): focused feature scenarios, controlled setup, and observable outcomes.

TypeScript checks the client, server, shared protocol, scripts, tests and build configuration. `strict` (including `noImplicitAny`) is enforced alongside checked indexed access, exact optional properties, index-signature bracket access and side-effect import checking. Clear absent optional state with `delete`; use `| undefined` only when an API intentionally distinguishes clearing a value from leaving it unchanged.

```sh
./scripts/test-runner.sh tests/integration/browser/sanity/game-initializes-with-arena-and-starting-state.test.ts --reporter=verbose
```

Debug switches and log levels live in `src/constants/index.ts`. Client and server diagnostics share structured records with release, player, session and connection context. The [diagnostics guide](docs/diagnostics.md) explains the incident timeline reader, Railway/Vercel searches, state checkpoints, loss counters and game-loop profiling. See `AGENTS.md` for architecture and commands.

Repeatable client, server, snapshot codec and loopback transport measurements use
the [benchmark framework](benchmarks/README.md). It documents clean committed
harness requirements, revision isolation, paired comparisons and raw artifacts.
The framework reports fixture timings, work counts and outcome equality; it does
not claim a generic optimization or supported capacity.

## Production

The static client deploys through Vercel's Git integration when a CI-approved PR merges to `main`. Branch pushes do not create Preview deployments; comment `/preview` as the first non-empty line on a same-repo PR (or run the **Vercel Preview** workflow) for a one-shot Preview. The authoritative game server deploys separately on Railway. A client deployment alone does not publish server changes. The persistent world also requires the Railway volume in `.railway/railway.ts`, mounted at `/data`, with `GEOROIDS_WORLD_PATH=/data/world.sqlite`.

- Client: [www.georoids.com](https://www.georoids.com)
- Server health: [Railway health endpoint](https://geoasteroids-production-2403.up.railway.app/health)
- Client production WebSocket: `wss://geoasteroids-production-2403.up.railway.app/ws`

World storage, backup, and recovery are described in [persistent world operations](docs/persistent-world.md).

Verify the deployed commit using each service's `x-release-id` header. Full deployment instructions are in `AGENTS.md`.

## Art and contributions

The recovered reference sheets, canonical vector assets, palette and provenance are indexed in [georoids-art/README.md](georoids-art/README.md). Runtime ship, EO satellite and mineral geometry generates the matching SVG assets.

Contributions use topic branches and pull requests with green `CI / ci`; direct pushes to `main` are reserved for emergencies. Use Conventional Commits with a scope and include relevant validation.

[MIT license](LICENSE)

Production disables test and diagnostic-write HTTP routes. WebSocket admission and joins always require the current snapshot protocol; reconnects use the private resume token.
