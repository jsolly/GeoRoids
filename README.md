# GeoRoids

A multiplayer vector spaceship game. Play at [www.georoids.com](https://www.georoids.com).

The Vite + TypeScript client renders and predicts the local ship. A Node WebSocket server owns the shared world, combat, asteroid field, bots, NPCs and rewards. MongoDB is not required.

## Local development

Use Node 24 or newer. On macOS, the native `canvas` dependency requires Cairo, Pango, libjpeg, giflib and librsvg.

```sh
git clone git@github.com:jsolly/GeoRoids.git
cd GeoRoids
npm ci
touch .env
npm run dev
```

Vite serves the client at `http://localhost:5173`; the game server listens on port 3001. Vite proxies `/ws` to the local server. Optional `VITE_WEBSOCKET_URL` configuration is documented in `.env.example`.

Choose a ship, enter the game, use arrow keys to turn and thrust, Space to fire, E for the selected kit's ability and F for the shield. Mobile players use the on-screen controls. The minimap provides the wider arena view.

## Verification

Run commands from the repository directory:

```sh
npm run gate
npm run test
npm run test:integration:server
npm run test:integration:browser
```

`npm run gate` checks dependencies, lint, configuration, TypeScript, unit tests and the production build. Browser tests need the Playwright browser installation (`npx playwright install`). Always use `./scripts/test-runner.sh` for individual integration scenarios; it enforces serialized execution.

```sh
./scripts/test-runner.sh tests/integration/browser/sanity/game-initializes-with-arena-and-hud.test.ts --reporter=verbose
```

Debug switches and log levels live in `src/constants/index.ts`. Set `DEBUG.ENABLED` and `LOGGING.GLOBAL_LOG_LEVEL` deliberately; client and server logs are written under `logs/`. See `AGENTS.md` for architecture, commands and detailed test guidance.

## Production

The static client deploys through Vercel's Git integration when a CI-approved PR merges to `main`. The authoritative game server deploys separately on Railway. A client deployment alone does not publish server changes.

- Client: [www.georoids.com](https://www.georoids.com)
- Server health: [Railway health endpoint](https://geoasteroids-production-2403.up.railway.app/health)
- Client production WebSocket: `wss://geoasteroids-production-2403.up.railway.app/ws`

Verify the deployed commit using each service's `x-release-id` header. Full deployment instructions are in `AGENTS.md`.

## Art and contributions

The recovered reference sheets, canonical vector assets, palette and provenance are indexed in [georoids-art/README.md](georoids-art/README.md). Runtime ship, EO satellite and mineral geometry generates the matching SVG assets.

Contributions use topic branches and pull requests with green `CI / ci`; direct pushes to `main` are reserved for emergencies. Use Conventional Commits with a scope and include relevant validation.

[MIT license](LICENSE)
