# Railway Infrastructure as Code

`.railway/railway.ts` is the single tracked Railway project definition. It
describes the `geoasteroids` service, its GitHub source, Railpack build, server
start command, healthcheck, replica placement, persistent world volume, and environment. The two existing service variables use `preserve()`; `GEOROIDS_WORLD_PATH` points at `/data/world.sqlite`. Client admission is always
current-protocol-only in server code; no service variable controls it.

The earlier service definition was compared with an authenticated full-project pull and plan. The new world volume and path require a fresh reviewed plan before deployment. Railway's documented restart defaults are `ON_FAILURE` with 10 retries;
these values are verified on the service and omitted from the definition because
Railway omits them from its imported graph. Compare the complete live graph before
applying, and preserve unrelated staged dashboard changes.

Install the pinned TypeScript DSL package from the repository root before using
the config:

```sh
cd /Users/johnsolly/code/GeoRoids
npm ci
npm exec --yes --package=@railway/cli@5.50.2 -- railway login
```

The CLI must be version 5.42.1 or newer. Link the repository directory to the
intended Railway project and production environment, then review a redacted
plan:

```sh
cd /Users/johnsolly/code/GeoRoids
npm exec --yes --package=@railway/cli@5.50.2 -- railway link --project 08a7b6ee-af66-4c58-a21e-700d5468ee14 --environment production --service geoasteroids
npm exec --yes --package=@railway/cli@5.50.2 -- railway config pull --json
npm exec --yes --package=@railway/cli@5.50.2 -- railway config plan --json
```

`railway config plan` is read-only. Review any staged dashboard changes before
running `railway config apply`; applying changes the live service and may deploy
it. Never use `--include-variables` for
this project. Generated Railway service domains are platform-managed and are
intentionally absent from the authoring file.

The `world-data` volume mounts at `/data` on the single `iad` replica. Apply this mount and the database path before deploying the persistent-world server. At startup, the production server requires Railway's `RAILWAY_VOLUME_MOUNT_PATH` and verifies that the database belongs directly in that directory. Railway's current IaC apply discards `deploy.requiredMountPath`, so the check lives in `server.ts`. Configure daily and weekly Railway volume backups and verify the live schedule after creating the volume; the SQLite WAL and database belong on the same volume. See [world operations](../docs/persistent-world.md).
