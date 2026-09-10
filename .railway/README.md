# Railway Infrastructure as Code

`.railway/railway.ts` is the single tracked Railway project definition. It
describes the `geoasteroids` service, its GitHub source, Railpack build, server
start command, healthcheck, replica placement, and the three
existing service variables through `preserve()`.

The definition has been compared with an authenticated full-project pull and
plan. Railway's documented restart defaults are `ON_FAILURE` with 10 retries;
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
