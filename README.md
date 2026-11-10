# GeoRoids

A cooperative open-world spaceship game with surveying, asteroid towing, and shared mineral deliveries. Play at [www.georoids.com](https://www.georoids.com).

Astro produces the static pages, and Svelte 5 with shadcn-svelte owns the interfaces. The TypeScript canvas engine renders and predicts the local ship. A Node WebSocket server owns the shared world, combat, asteroid field, NPCs and rewards.

## Local development

Use Node 26 (`nvm use`). `package.json` requires `^26.0.0`; jsdom accepts that major from 26.0.0. On macOS, the native `canvas` dependency requires Cairo, Pango, libjpeg, giflib and librsvg.

```sh
git clone git@github.com:jsolly/GeoRoids.git
cd GeoRoids
npm ci
npm run dev
```

Astro serves the client at `http://localhost:5173`; the game server listens on port 3001. `npm run dev` routes `/ws` and `/logs` through Astro's Vite proxy to the local server, including custom dev ports. A public HTTPS tunnel to Astro therefore also carries the game WebSocket, so phones never connect to their own `localhost`. Direct Astro and production endpoint configuration is documented in `config/app/.env.example`.

Choose a ship, enter the game, steer with the mouse or left/right arrow keys while thrust stays on, Space to fire, E to scan as Scout or attach/release cargo as Hauler. Mobile players use the on-screen controls. The minimap follows your ship through the 120,000-unit-wide world. Shared fog records discoveries; Scouts reveal more terrain, and discovered furnaces remain marked.

Every player belongs to the crew. Direct crew lasers pass through ships; a bounced shot becomes a ricochet that can hurt you or another pilot. Tow a scanned asteroid into a furnace to give both the Hauler and its Scouts the full reward, including Scouts who are offline.

Reflective asteroid clusters can bounce lasers and release ordinary salvage. The [asteroid interactions guide](docs/asteroid-interactions.md) covers reflection, ricochet energy and the shared snapshot behavior.

## Frontend ownership

The Svelte shell imports the browser runtime after mounting and sends commands through its UI port. Read-only, bounded presentation values update at most ten times per second; semantic transitions publish immediately. The engine retains canvas dimensions, pixels and world state. Unmount and HMR dispose the runtime and its owned work. See [architecture](docs/agent-operations.md#architecture).

## Field manual

The companion player manual is built at `/wiki/` on the same client origin. It covers ship abilities and game mechanics with searchable articles, a ship comparison, and playable GIF demonstrations. The game title screen links to it.

See [manual maintenance](docs/wiki-maintenance.md) for content, reproducible media generation, and the source-review gate, and [coverage](docs/wiki-coverage.md) for the mechanic inventory. `npm run check:wiki` is part of the production build and flags gameplay changes that need a documentation review.

## Verification

Run the complete gate before publication; [CI and local review](docs/ci-and-local-review.md#local-review) owns its stages and evidence requirements.

TypeScript checks the client, server, shared protocol, scripts, tests and build configuration. `strict` (including `noImplicitAny`) is enforced alongside checked indexed access, exact optional properties, index-signature bracket access and side-effect import checking. Clear absent optional state with `delete`; use `| undefined` only when an API intentionally distinguishes clearing a value from leaving it unchanged.

Simulation debug switches live in `shared/constants/gameplay.ts`; log levels live in `src/constants/index.ts`. Client and server diagnostics share structured records with release, player, session and connection context. The [diagnostics guide](docs/diagnostics.md) explains the incident timeline reader, Railway/Vercel searches, state checkpoints, loss counters and game-loop profiling. See `AGENTS.md` for architecture and commands.

Repeatable client, server, snapshot codec and loopback transport measurements use
the [benchmark framework](benchmarks/README.md). It documents clean committed
harness requirements, revision isolation, paired comparisons and raw artifacts.
The framework reports fixture timings, work counts and outcome equality; it does
not claim a generic optimization or supported capacity. Browser benchmarks and frame measurements remain manual tools outside the test gate; Playwright is retained for them. Wiki media uses node-canvas and Python with `scripts/wiki-media-requirements.txt` (`WIKI_MEDIA_PYTHON`), without a browser; CI's `wiki-media` lane verifies the committed baseline.

## Production

The static client deploys through Vercel's Git integration when a CI-approved PR merges to `main`. Branch pushes do not create Preview deployments; an owner can comment `/preview` on a pull request to deploy it, client and server together, to the shared Railway preview environment. The authoritative game server also auto-deploys from `main` on Railway, through its own Git integration. Verify both deployed releases; a successful client deployment alone does not prove the server updated. If the expected Railway deployment is missing, inspect its trigger before using an exact-commit manual fallback, and never apply unrelated staged environment changes. The persistent world also requires the Railway volume in `.railway/railway.ts`, mounted at `/data`, with `GEOROIDS_WORLD_PATH=/data/world.sqlite`.

- Client: [www.georoids.com](https://www.georoids.com)
- Server health: [Railway health endpoint](https://georoids-production-2403.up.railway.app/health)
- Client production WebSocket: `wss://georoids-production-2403.up.railway.app/ws`

World storage, backup, and recovery are described in [persistent world operations](docs/persistent-world.md).

Successful production Git deployments establish the release; metadata is diagnostic. Follow [deployment verification](docs/agent-operations.md#deploy).

## Art and contributions

The recovered reference sheets, canonical vector assets, palette and provenance are indexed in [georoids-art/README.md](georoids-art/README.md). Runtime ship, EO satellite and mineral geometry generates the matching SVG assets.

Contributions use topic branches and pull requests that merge on green `CI / ci`. Non-draft pull requests from `solly-agent`, `jsolly`, or `cursor[bot]` arm squash auto-merge; convert one to a draft, or run `gh pr merge --disable-auto`, to hold it. Direct pushes to `main` are reserved for an emergency the maintainer explicitly authorizes. Use Conventional Commits with a scope and include relevant validation.

[Apache-2.0 license](LICENSE)

Production disables test and diagnostic-write HTTP routes. WebSocket admission and joins always require the current snapshot protocol; reconnects use the private resume token.
