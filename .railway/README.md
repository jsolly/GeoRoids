# Railway production configuration

`.railway/railway.ts` describes production. Railway's Git integration deploys
server code from `main`; merging this definition alone does not apply service
configuration. The preview workflow removes `.railway/` before uploading code
and must never receive this production definition or its token.

The build pins Railpack at `0.43.0`. Move `build.railpackVersion` and
`scripts/railpack-build.sh` together. The `railpack-build` CI lane checks the
same version, while configuration readback and the deployed build log establish
which version production actually uses.

## Manual planning is enabled; application remains disabled

John authorized plan-only setup on 2026-11-14. The **Railway version pin**
workflow accepts only a manual dispatch from `main` in `jsolly/GeoRoids`.
It invokes the guarded runner with `--plan-only` and fixes
`RAILWAY_CONFIG_APPLY_ENABLED` to `disabled`. There is no apply input or push
trigger. A secret, input or environment variable cannot enable application.
Production application and automatic triggers require separate authorization
and a reviewed workflow change.

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
build setting. Only a well-formed empty `STAGED` draft permits planning; the
runner never applies, discards or rewrites dashboard work.

The pinned API returns a non-null `EnvironmentPatch`, including when its patch
has no work. The runner checks the exact `id`, `status` and `patch` fields.
Only absent or empty service, shared-variable, volume and bucket maps, with an
absent or null private-network toggle, count as empty. Any resource entry,
variable, toggle, applying/committed/unknown status, unknown field or malformed
value blocks the run, even if a dashboard summary reports no changes.

When that guard rejects a response, its error reports only fixed status and
response-shape labels. The staged patch is queried with variable decryption
disabled; no patch keys, values or identifiers are logged. These labels help
diagnose provider-contract mismatches without treating a connector's empty
summary as permission to continue.

## Prepare an authorized first run

The workflow needs a dedicated token and a protected GitHub Environment before
its first live plan. This repository change creates neither. John provisions
the credential through the provider interfaces; never paste it into a chat,
task, source file or workflow log. No production apply is authorized by the
plan-only setup.

1. Review the production staged changes independently. Any pending work must
   be resolved separately and remain untouched by this runner.
   Verify the staged patch is empty under the strict draft checks above.
   Before any separately authorized apply, verify that concurrent staged
   changes invalidate the apply etag.
2. Confirm the fixed service ID still has the exact name `Georoids`. An
   authenticated read on 2026-11-13 verified that identity, and the tracked
   definition and runner use `service.Georoids`. Railway derives IaC addresses
   from exact names. Any later identity drift blocks automation and requires
   review; the runner never renames or replaces a service.
3. Create a new Railway project token scoped only to the exact production
   environment. Store it as `RAILWAY_CONFIG_TOKEN` in the GitHub Environment
   `railway-production-config`, restricted to `main`. Never copy or reuse the
   `railway-preview` token, a user token, or a workspace token. Keep the
   Environment variable `RAILWAY_CONFIG_APPLY_ENABLED` absent or `false`.
4. Dispatch **Railway version pin** from `main`. The workflow takes no inputs
   and uses checksum-pinned official Railway CLI `5.50.2` on the clean current
   merged checkout. The runner validates the real saved plan's structured
   `changeSet`, build payload and exact target mapping, rather than its text
   summary. Unknown provider fields or different live contracts fail and require
   review. Never request `--show-values`, `--decrypt-variables` or
   `--include-variables`. Raw JSON stays private and is deleted after the run.
5. Review the small Actions receipt. It must report `outcome: plan-only`, the
   intended version and change kind, and `deploymentId: null`. This is planning
   evidence, never proof that the pin is live. Resolve any failed provider or
   staged-state check before another run.

Before any future application or unattended operation, obtain separate approval
and review the workflow change that admits it. Verify the live terminal apply
response contract: the pinned public schema declares aggregate `status` as
`String` and `diagnostics` as `JSON`. The runner admits only `applied`, empty
diagnostic arrays, one applied operation, a deployment ID and no staged patch ID.
Synthetic tests do not prove those live values or concurrent staged-work
semantics. Setting a variable to `true` does not enable the current workflow.

Do not run `railway login`, `link`, `config pull --force`, setup installers or
config cleanup as part of automation. The workflow uses only the dedicated
project token and fixed IDs. Token scope is established during provisioning;
source code cannot prove how a supplied token was issued.

The runner also sets the child process's `_` executable path to the verified
CLI. The TypeScript SDK uses that path for its native-evaluation version check;
inheriting the workflow's Node launcher makes that check reject planning.
Failed CLI calls report a fixed phase label while withholding provider output.
Saved-plan rejection identifies only fixed failed-check labels, including the
destructive-change guard; it never prints rejected field values. The definition
preserves the intentionally configured `TODOIST_API_TOKEN` without reading,
copying, setting or deleting it. Omitted service variables are deletion requests
in the pinned planner, so human-owned credentials must remain explicitly preserved.

## Inspect first ownership without applying

John authorized the separate **Railway ownership plan** workflow on 2026-11-15.
Dispatch it manually from current `main`, with no inputs. It shares the pin
workflow's concurrency group, checksum-pinned CLI `5.50.2` and main-restricted
`railway-production-config` Environment. Its entry point accepts no arguments
and has no application mode. The pin workflow still rejects ownership claims.

The workflow queries `iacPartials` with the fixed production IDs, verifies the
existing service and `world-data` volume mapping, its 1024 MB `iad` configuration
and `/data` mount, and refuses staged work. The pinned native model treats an
explicit null ownership map as unowned. A missing field, query error, malformed
map, incomplete mapping or an address outside the two declared resources blocks
inspection. There is no compatibility query that silently omits ownership.

An initial `owners-observed` JSON line records each exact address and resource
ID, current owner, intended owner `*` and whether that address needs a claim.
It has `planVerified: false`; it remains useful if native planning fails but
does not prove a plan. Foreign named ownership is never transferred.

The workflow plans the unchanged production definition. That definition includes
the desired Railpack pin, so this is a diagnostic plan, not an ownership-only
adoption plan. The complete saved artifact must match the pinned format, source
tree, target, configuration etag, hash and declared resources. Every proposed
operation receives an ordered inventory row, with fixed kind/address/field
labels and an unknown-field count. Unrecognized text and all raw operation
values, summaries, diagnostic messages and variable values stay private.
Oversized or untrusted artifacts fail explicitly rather than truncating rows.

Exact service `build` and `deploy` updates also include `settingDetails`. This
fixed-schema projection reports changed known paths and distinguishes absent,
null, typed safe values and withheld values. Only reviewed enums, bounded numbers,
booleans, version numbers and the exact existing start command and health path
can be printed. Arbitrary keys, commands, URLs, variables, summaries and diagnostic
text remain private. Unknown fields are counted without their names. Unknown
fields, malformed containers or withheld changed values mark details incomplete;
other operations are explicitly not inspected. The complete/incomplete label
describes diagnostic detail coverage, never policy acceptance or apply readiness.
The original setting guard still reviews the entire unchanged saved artifact.

After inventory, the shared complete settings review determines whether only
the pin would change. Ownership inspection does not bypass, rewrite or filter
the saved artifact. Even a policy-blocked inventory must pass a second snapshot,
current-source and unchanged-byte check before its final receipt is emitted.
The full masked configuration and ownership map must remain stable. Drift or
incomplete validation leaves the inventory unverified.

The final JSON receipt contains every row, operation/diagnostic counts, per-address
ownership, aggregate claim consistency, settings disposition, native change-set
hash and raw artifact digest. `applicationEnabled` and `liveApprovalReady` are
always false, with `deploymentId: null`. `pinPolicyAccepted: false` remains
expected when first ownership is needed; it cannot enable application. Foreign
owners, inconsistent claim metadata, destructive changes, diagnostics or settings
outside the pin policy emit the complete sanitized receipt and fail the job.
Raw plans and query results are never uploaded and temporary files are deleted
on exit. A failed run is not permission to retry or change production.

### Ownership release is a separate prerequisite

First apply records resource-level ownership even with zero setting changes.
The current unnamed definition uses owner `*`; it would manage the declared
service and volume, rather than only `build.railpackVersion`. Future whole-project
plans can propose deleting omitted services. No ownership adoption is authorized
by either planning workflow.

CLI `5.50.2` has no `config partials` management command. Official CLI `5.74.0`
adds list, release and transfer, with etag-bound previews; release and transfer
require environment ADMIN access and accept named partials. Its named-partial
parser rejects `*`, so these commands do not establish a rollback for adopting
the current whole-project owner. This workflow does not upgrade the CLI, probe
ADMIN access or execute ownership mutations. A source revert alone would not
undo provider ownership.

Before any adoption, separately decide the owner model, prove a supported release
procedure and access, review a fresh ownership-only plan with zero setting
operations and exact existing IDs, and obtain explicit approval for its exact
digest. The version pin remains a later, independently guarded application.
Automatic application remains a separate authorization and reviewed change.

Primary sources for ownership inspection and release research:

- [Pinned native owner-map query and null handling](https://github.com/railwayapp/cli/blob/v5.50.2/src/iac/engine.rs)
- [Pinned ownership predicate and names](https://github.com/railwayapp/cli/blob/v5.50.2/src/iac/partial.rs)
- [CLI 5.74.0 ownership command requirements](https://github.com/railwayapp/cli/blob/v5.74.0/src/commands/config/partials.rs)
- [CLI 5.74.0 named ownership and etag checks](https://github.com/railwayapp/cli/blob/v5.74.0/src/iac/ownership.rs)

## Saved-plan and verification contract

The serialized planning job checks out its exact triggering SHA. The runner
requires that SHA to remain the clean current `main` checkout before planning
and applying. A superseded run fails; it never reverts a newer pin. Action
versions, the official CLI archive and its extracted binary have separate pins.

The runner keeps the raw plan in a private temporary directory with a restrictive
umask. It validates CLI version, plan format, `.railway/` source tree, change-set
hash, configuration etag, exact target and the permitted change. It reads staged
state and the etag again, then returns the plan-only receipt without applying,
reading build logs or claiming deployment verification.

The guarded runner retains a separately gated apply path for future approval.
That path checks saved bytes, then passes that same file to
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
