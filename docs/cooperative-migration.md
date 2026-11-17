# Activate the cooperative campaign

The code ships inactive against an existing world. Ordinary startup reads the
optional schema; it never creates the campaign tables, backfills progress or
activates features. Tool travel tuning does not need this migration.

John owns all production migration, activation, configuration and recovery
operations. No production operation was run while preparing this change. Review
and test the exact server release and this runbook first. Keep the existing
`GEOROIDS_WORLD_PATH=/data/world.sqlite`, volume at `/data`, and world generation 1.

## Review and local proof

The migration adds `cooperative_schema` and `cooperative_records` in a single
transaction. It fingerprints the existing world, sectors, economy and pilots
without exposing credential hashes. Apply requires that fingerprint and creates
a new SQLite backup including committed WAL state; the backup fingerprint must
match before schema changes begin. A second inspection is required before the
separate activation command. A stale fingerprint, partial schema, unsupported
version or malformed campaign record fails closed.

Local coverage lives in
`tests/unit/server/cooperative-migration-preserves-the-existing-world.test.ts`.
It exercises dry run, exact backup, inactive migration, repeated migration,
activation refusal, worker restart, old civic IDs and atomic pilot/campaign
rollback. Downed deadlines, supplies, completion and snapshot transport have
separate campaign scenario tests.

## Human production preflight

### Keep the container available without starting gameplay

The separate `server/maintenance.ts` entrypoint keeps an HTTP listener alive for
Railway Console access. It imports no game engine, world store, backup scheduler
or debug-report writer. It does not open the world, create a database, run a
migration, activate a campaign or start gameplay. Database operations remain
separate, explicitly approved operator commands in the Console. It provides no
HTTP command endpoint.

After reviewing and publishing a release containing this entrypoint, John can
approve a maintenance deployment on the existing production service and volume.
Its exact start command is:

```sh
node --import tsx server/maintenance.ts
```

This is a proposed production configuration handoff, not a command to run beside
the existing game process. Keep one replica and the existing `/data` mount and
world generation. Preserve unrelated staged Railway changes and the separately
held exploration-storage rollout. Do not use the environment-wide Apply/Deploy
button to enter maintenance, and do not use a pre-deploy hook: Railway does not
mount the volume during pre-deploy.

Establish the maintenance window and stop live play. Verify the previous game
instance completed its graceful final checkpoint, released its writer and
terminated before accepting the new maintenance instance as exclusive access.
A failed/skipped final flush is a stop condition. Railway's attached-volume
deployment exclusivity helps prevent overlapping instances, but neither a
zero-player pause nor a successful health check proves the old writer closed.
Do not suspend or kill a live writer as a shortcut.

`GET /health` and `HEAD /health` return 200 for container readiness. The JSON body
explicitly says `status: "maintenance"`, `gameplayAvailable: false` and
`worldOpened: false`, with the release ID. Every other HTTP request and every
WebSocket upgrade returns 503. The response never echoes request data. Canonical
gameplay smoke is expected to fail during this window; readiness is not gameplay
or persistence health. Coordinate that expected outage without silently disabling
alerts or changing workflows.

Open the maintenance instance's Console and verify its release and volume using
the preflight below. The ready event records the actual port but does not claim
the volume exists or is correct. If the Console shell cannot find `node`,
`readlink -f /proc/1/exe` identifies the maintenance process's executable. Use the
observed absolute path for subsequent approved commands; do not guess an install
path or change production PATH. Inspection, backup, apply and activation remain
separate steps with their original approval and receipt requirements.

After separately approved activation, restore the exact normal start command
`node --import tsx server.ts` through a reviewed service-specific configuration
and deployment handoff. A bare restart retains the maintenance start command and
does not restore gameplay. Verify the new ordinary game instance, genuine active
campaign join and healthy subsequent persistence before ending maintenance.

Local verification uses disposable databases and real loopback connections. It
does not establish actual Railway graceful replacement, Console access, backup,
migration, activation or recovery on the production volume. No in-game Wiki rule,
control or demonstration changes: this is operator-only startup tooling.

### Verify the existing production target

The verified production target is project
`08a7b6ee-af66-4c58-a21e-700d5468ee14`, environment
`94d3de2f-4bb0-4051-8975-a30190c2fffa`, service
`4e2cb2a2-c1e2-41a8-a970-3f60659c2524`. An isolated shared
[preview environment](agent-operations.md#railway-preview) now exists; the
commands below target production only. Preview success does not authorize
production migration or activation.
The remote application directory has not been verified; do not assume `/app`.

From any local directory, John can open the exact service's shell using the
[Railway SSH command](https://docs.railway.com/cli/ssh):

```sh
railway ssh --project 08a7b6ee-af66-4c58-a21e-700d5468ee14 --environment 94d3de2f-4bb0-4051-8975-a30190c2fffa --service 4e2cb2a2-c1e2-41a8-a970-3f60659c2524
```

Inside that shell, this read-only preflight prints the actual working directory
and refuses missing release files or a mismatched volume path:

```sh
node -e 'const fs=require("node:fs"); console.log(process.cwd()); fs.accessSync("scripts/migrate-cooperative-world.ts"); fs.accessSync("server/world/cooperativeSchema.ts"); fs.accessSync("/data/world.sqlite"); if(process.env.GEOROIDS_WORLD_PATH!=="/data/world.sqlite" || process.env.RAILWAY_VOLUME_MOUNT_PATH!=="/data") throw new Error("Unexpected world volume"); console.log(require.resolve("tsx"))'
```

If preflight fails, stop. Resolve release packaging or the actual application
root before continuing. The remaining commands run in that verified remote
application directory. Arrange a maintenance window without live play and retain
the platform volume backup as well as the SQLite backup below. Concurrent world
writes invalidate the receipt and require a fresh inspection, never a bypass.

## Inspect, apply, inspect, activate

Read-only inspection; its output contains a legacy fingerprint, not pilot data:

```sh
node --import tsx scripts/migrate-cooperative-world.ts dry-run /data/world.sqlite > /data/cooperative-inspection.json
```

Apply the reviewed additive migration using that exact receipt. The backup name
must be unused; `VACUUM INTO` refuses an existing file. Keep the receipt and backup
as release evidence:

```sh
node --import tsx scripts/migrate-cooperative-world.ts apply /data/world.sqlite "$(node -p 'JSON.parse(require("node:fs").readFileSync("/data/cooperative-inspection.json","utf8")).legacyDigest')" /data/world-before-cooperative-v1.sqlite
```

Inspect the resulting inactive schema and preserve its current fingerprint:

```sh
node --import tsx scripts/migrate-cooperative-world.ts inspect /data/world.sqlite > /data/cooperative-migrated.json
```

After reviewing `schemaVersion: 1`, `activated: false` and
`legacyRowsPreserved: true`, activate using the new receipt:

```sh
node --import tsx scripts/migrate-cooperative-world.ts activate /data/world.sqlite "$(node -p 'JSON.parse(require("node:fs").readFileSync("/data/cooperative-migrated.json","utf8")).legacyDigest')"
```

Restart the reviewed server release through the established Railway procedure;
the running process keeps its startup activation state until restart. Verify a
fresh genuine join with snapshot v3, asteroid interactions and cooperative
capability 1; observe campaign state, accepted movement/firing and healthy
write-behind persistence. Client deployment alone cannot prove server activation.

## Recovery and permanence

Campaign rows and changed pilots/asteroids share the existing checkpoint
transaction. Queen clearance, sac completion, restoration and Deep Scanner
completion are permanent; downed deadlines use server epoch time, while births
count only active simulation frames. A hard crash retains the last committed
checkpoint, consistent with the existing world contract.

If verification fails, stop live play and follow the human-owned volume recovery
procedure in [persistent world operations](persistent-world.md#railway-deployment-and-recovery).
Never copy a SQLite main file over a live writer or discard WAL/SHM files while
it is running. Restoring the pre-migration backup loses subsequent play, so it
requires an explicit recovery decision; do not silently reset or downgrade the
world. Merely reverting client code cannot safely run old clients against an
activated campaign server: the server refuses clients lacking its capability.
