# Railway production configuration

`.railway/railway.ts` describes production. Railway's Git integration deploys
server code from `main`; merging this definition alone does not apply service
configuration. The preview workflow removes `.railway/` before uploading code
and must never receive this production definition or its token.

The build pins Railpack at `0.43.0`. Move `build.railpackVersion` and
`scripts/railpack-build.sh` together. The `railpack-build` CI lane checks the
same version, while configuration readback and the deployed build log establish
which version production actually uses.

## Version-pin automation remains disabled

`.github/workflows/railway-version-pin.yml` has an impossible repository guard,
`DISABLED/REQUIRES-APPROVAL`. No secret, variable or manual dispatch can enable
that job. A separately authorized, reviewed change must remove that conjunct
while preserving the exact `jsolly/GeoRoids` and `main` guards. The separate
apply control defaults off; enabling the job permits read-only planning first.

The approved policy covers only `build.railpackVersion` on the existing service:

| Resource | Exact ID |
| --- | --- |
| Project | `08a7b6ee-af66-4c58-a21e-700d5468ee14` |
| Production environment | `94d3de2f-4bb0-4051-8975-a30190c2fffa` |
| Server service | `4e2cb2a2-c1e2-41a8-a970-3f60659c2524` |

The runner rejects resource creation or deletion, variables, secrets, commands,
volumes, domains, placement, replicas, runtime changes, ownership claims,
unknown fields and multiple changes. It compares the entire build before and
after the proposed update. A harmless-looking summary cannot conceal another
build setting. Any existing staged object blocks the run; the runner never
applies, discards or rewrites dashboard work.

## Prepare an authorized first run

These production steps require John's separate authorization. This repository
change does not create a token, configure secrets, resolve dashboard work,
enable the workflow or apply production configuration.

1. Review the production staged changes independently. The previously observed
   staged patch contains unrelated work and must remain untouched by this runner.
   Verify that `environmentStagedChanges` returns `null` only when no staged work
   exists, and that concurrent staged changes invalidate the apply etag.
2. Confirm the fixed service ID still has the exact name `Georoids`. An
   authenticated read on 2026-11-13 verified that identity, and the tracked
   definition and runner use `service.Georoids`. Railway derives IaC addresses
   from exact names. Any later identity drift blocks automation and requires
   review; the runner never renames or replaces a service.
3. Obtain a real read-only saved plan using official Railway CLI `5.50.2` on the
   exact clean merged checkout. Review the structured `changeSet`, not its text
   summary. Check the runner's build payload and target mapping against that
   output. Never request `--show-values`, `--decrypt-variables` or
   `--include-variables`. Keep raw JSON private and delete it after review.
4. Verify the live terminal apply response contract before enabling unattended
   operation. The pinned public schema declares aggregate `status` as `String`
   and `diagnostics` as `JSON`. The runner admits only `applied`, empty diagnostic
   arrays, one applied operation, a deployment ID and no staged patch ID. Unknown
   or different provider responses fail and require review. Synthetic tests do
   not prove those live values or staged-work semantics.
5. Create a new Railway project token scoped only to the exact production
   environment. Store it as `RAILWAY_CONFIG_TOKEN` in the GitHub Environment
   `railway-production-config`, restricted to `main`. Never copy or reuse the
   `railway-preview` token, a user token, or a workspace token.
6. After separate approval, remove the workflow's impossible repository conjunct
   in a reviewed enabling change, keeping the exact repository and main guards.
   Keep the GitHub Environment variable `RAILWAY_CONFIG_APPLY_ENABLED` absent or
   `false`. Dispatch **Railway version pin** from `main` with mode `plan-only`,
   the default choice. That path already exists and returns `plan-only`, never
   production proof. No implementation change is needed to select the mode.
7. After separate apply approval and the preceding checks, set that environment
   variable to exactly `true`. Merged main changes then select apply. A manual
   dispatch still defaults to `plan-only`; choosing `apply` also requires the
   separate apply control. Any other variable value keeps apply disabled.
   The workflow maps this control to the runner's internal
   `RAILWAY_CONFIG_APPLY_ENABLED=version-pin-only` flag. Mode text reaches the
   runner through an environment variable and is validated before use.

Do not run `railway login`, `link`, `config pull --force`, setup installers or
config cleanup as part of automation. The workflow uses only the dedicated
project token and fixed IDs. Token scope is established during provisioning;
source code cannot prove how a supplied token was issued.

## Saved-plan and verification contract

The serialized production job checks out its exact triggering SHA. The runner
requires that SHA to remain the clean current `main` checkout before planning
and applying. A superseded run fails; it never reverts a newer pin. Action
versions, the official CLI archive and its extracted binary have separate pins.

The runner keeps the raw plan in a private temporary directory with a restrictive
umask. It validates CLI version, plan format, `.railway/` source tree, change-set
hash, configuration etag, exact target and the permitted change. It reads staged
state and the etag again, checks saved bytes, then passes that same file to
`railway config apply --plan ... --yes --json`. The CLI independently verifies
the source tree and hash, recomputes destructive status from the changes and
passes the expected etag to the provider. There is no destructive confirmation
or fresh-plan apply fallback.

After apply, the runner follows the returned deployment to `SUCCESS`. It reads
the actual production pin, verifies the current deployment ID, checks that
deployment's build log for `using build driver railpack-v<version>`, and runs the
canonical HTTP and gameplay protocol smoke. A final read confirms the pin,
deployment and empty staged state after smoke. Missing readback, deployment,
logs or smoke fails verification. A retry that finds a converged no-op must
prove the existing deployment the same way. The runner never redeploys as a
fallback and never retries an ambiguous apply blindly.

Only a small result containing the outcome, version, change kind and deployment
ID reaches the Actions summary. Raw plans, query results, variable values and
build logs are never logged or uploaded. Temporary plan and smoke files are
removed in `finally`; a cancelled hosted runner destroys its temporary disk.
A failed or interrupted run requires actual production readback before retry.
It does not imply that an earlier apply was rolled back.

The guard follows these pinned official sources:

- [Saved-plan format and native checks](https://github.com/railwayapp/cli/blob/v5.50.2/src/iac/saved_plan.rs)
- [Whole-field update payloads](https://github.com/railwayapp/cli/blob/v5.50.2/src/iac/change_set.rs)
- [Environment read and apply response](https://github.com/railwayapp/cli/blob/v5.50.2/src/iac/engine.rs)
- [Staged-work query](https://github.com/railwayapp/cli/blob/v5.50.2/src/gql/queries/strings/EnvironmentStagedChanges.graphql)
- [Public response schema](https://github.com/railwayapp/cli/blob/v5.50.2/src/gql/schema.json)

One TypeScript runner owns sequencing and private files. Pure boundary parsers
own the admission policy. Keeping apply in the pinned CLI preserves its native
checks; splitting plan and apply into unrelated shell steps would make exact
file ownership harder to enforce. Tests exercise synthetic structured fixtures,
failures and command ordering, and make no claim of a real plan or apply.

## Human-owned world configuration

The `world-data` volume mounts at `/data` on one `iad` replica, and
`GEOROIDS_WORLD_PATH` points to `/data/world.sqlite`. Startup verifies Railway's
mount path before opening the database. Daily and weekly volume backups remain
human-owned. Railway's verified restart defaults are `ON_FAILURE` with 10
retries and are omitted because the importer omits them.

All configuration outside the approved version pin remains human-owned. Review
the complete live graph before a separate manual apply and preserve unrelated
staged work. Follow [world operations](../docs/persistent-world.md) before volume,
database, replica or recovery changes.
