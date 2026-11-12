# Exploration tile storage transition

Production data and schema operations remain human-owned. Publish the tooling
and the new reader and writer in separate reviewed phases. Git integration
deploys the server. Verify production volume health and complete the required
Wiki source review before either publication.

The [checkpoint design](exploration-storage-design.md) describes state ownership,
the worker contract and the alternatives considered.

## Offline tooling and states

Run from the root of the reviewed checkout with its installed Node dependencies:

```sh
node --import tsx scripts/migrate-exploration-storage.ts inspect /absolute/world.sqlite
node --import tsx scripts/migrate-exploration-storage.ts dry-run /absolute/world.sqlite
```

Both commands are read-only inspections, not simulated writes. They validate the
database integrity, metadata and exploration, and report the state, tile count
and SHA256 fingerprint. They never print pilot rows or credentials. A fingerprint
covers every application table and schema object, including cooperative state,
and binds each row to its table, so moving a row, a pilot write or an unrelated
schema change also invalidates a receipt.

| State | Meaning | Safe next action |
| --- | --- | --- |
| `legacy` | Atlas lives only in the world JSON. | `prepare` |
| `prepared` | Tile rows equal the retained atlas. | `activate`, while stopped |
| `stale-preparation` | The old writer changed the atlas after preparation. | Fresh inspection and `prepare` |
| `active` | World metadata has no atlas; tile rows own discoveries. | New server, or stopped `rollback` |

Each mutation requires the fresh inspection fingerprint and a new absolute
backup filename. The tool reserves that filename exclusively with permissions
0600, so even an existing empty file is refused. `VACUUM INTO` includes committed
WAL content. The tool checks database
integrity and verifies its complete logical fingerprint before changing source
data. It checks that fingerprint again under `BEGIN IMMEDIATE`. A concurrent
write before backup verification or lock acquisition therefore aborts the
operation. Data and schema changes commit together, and a failure rolls them
back. Operators must still stop the service: a fingerprint cannot prevent an
old process from writing after a completed preparation.

A repeated transition is logically idempotent with a fresh fingerprint and a
new verified backup. `prepare` leaves an already active database untouched.
`activate` requires an exact prepared copy and rejects stale copies. `rollback`
exports current tile rows to the legacy atlas before dropping the tile table;
it preserves discoveries made after activation. It also removes a merely
prepared copy without changing the still-authoritative legacy atlas.

## Phase 1: publish tooling with the old reader

Publish only these new files, plus their actual Wiki source review:

- `server/world/savedWorld.ts`
- `server/world/explorationSchema.ts`
- `scripts/migrate-exploration-storage.ts`
- `tests/fixtures/exploration-legacy-world.sql`
- `tests/unit/server/offline-exploration-storage-transition-preserves-progress.test.ts`
- This runbook and `docs/exploration-storage-design.md`.

These files do not import the new runtime writer or alter startup. Keep the old
`WorldStore`, persistence protocol, engine and shared exploration implementation
for this publication. The metadata parser in `savedWorld.ts` is independent of
`WorldStore`, so the offline tool works before the runtime changes land. In this
phase, keep its `SavedWorld` interface internal. Export that interface only in
Phase 2, when the runtime imports it, so unused-export checks remain effective.
The SQL fixture was captured using `WorldStore` at `42bea241` with synthetic
credentials and no production data. Its unchanged legacy world bytes remain
readable by that release after `prepare`.

After the tooling is reviewed, gated, on main and available to the operator,
take a fresh consistent legacy snapshot, verify its off-volume copy and record
an isolated restore rehearsal before changing production exploration storage.
The backup implementation may be published disabled before this transition;
creating its resources, supplying credentials, copying real data and running the
restore remain separately authorized operations. Do not infer approval from a
code merge or enable the recurring schedule as part of this transition.

Record a read-only inspection of that verified backup. Verify that the chosen
backup filesystem has space for each complete database copy and retains the
existing recovery points. Use a reviewed directory outside the constrained world
volume. The production volume is 1 GB; do not assume that several additional
copies fit beside the database and WAL. Rehearse the
prepare, activation, new reader load, new tile checkpoint and rollback export
against an isolated copy with the candidate runtime. Verify pilot scores,
cargo, economy, sectors, furnaces, world seed/generation and every atlas id/bits.
Retain the fingerprint and backup evidence outside Git. A malformed backup or
row fails the rehearsal; do not normalize it into a new world.

Preparation of production is a separate human-authorized data operation. It is
safe for the old reader because the world JSON remains byte-identical:

```sh
node --import tsx scripts/migrate-exploration-storage.ts prepare /data/world.sqlite CURRENT_INSPECTION_SHA256 /absolute/reviewed-backups/world-before-exploration-prepare-UNIQUE.sqlite
```

The old server may continue after preparation. Its next discoveries can make
the prepared copy stale. Phase 2 always starts with a fresh stopped-world
inspection and preparation; the old receipt is not reusable.

## Phase 2: maintenance window and new writer

Keep this phase's runtime code unpublished until its concrete review, complete
local gate and required production authorization are finished. Publication
activates the new server through the existing Git deployment path.

1. Have the operator stop the old service cleanly and prevent automatic restart
   for the maintenance window. Confirm its writer has closed. Do not run an old
   and new server together or increase the replica count.
2. Inspect the stopped database. Run `prepare` with that fresh fingerprint and
   a new backup path, even if it was prepared earlier. Inspect again and require
   `prepared`. Keep its backup and fingerprint.
3. Run activation using that latest fingerprint and another new backup:

   ```sh
   node --import tsx scripts/migrate-exploration-storage.ts activate /data/world.sqlite PREPARED_INSPECTION_SHA256 /absolute/reviewed-backups/world-before-exploration-activate-UNIQUE.sqlite
   ```

4. Inspect and require `active`. The old reader now refuses startup because its
   required atlas field is absent. The new reader refuses `legacy`, `prepared`
   and `stale-preparation` worlds. Neither reader silently regenerates progress.
5. Publish the separately reviewed/gated new runtime and let that deployment
   start one writer. Verify health/persistence, genuine join, unchanged shared
   map, a newly discovered tile committed through the worker, and restart
   durability through the canonical server release smoke. Client snapshots
   retain their existing protocol. Release metadata alone is not proof.

Do not activate if publication cannot follow in the same authorized maintenance
window. If the deployment cannot complete, export rollback before restarting the
old service. Do not let a partially completed rollout become an unattended
startup migration.

## Rollback and recovery

Stop the new service and confirm its writer has closed. Inspect the current
active database, then run:

```sh
node --import tsx scripts/migrate-exploration-storage.ts rollback /data/world.sqlite CURRENT_INSPECTION_SHA256 /absolute/reviewed-backups/world-before-exploration-rollback-UNIQUE.sqlite
```

Verify `legacy`, compare the exported atlas against the pre-rollback tile rows,
and verify every other table is unchanged. Only then restore the previously
reviewed server release and resume one writer. The export includes discoveries
made after transition. A prepared-only rollback leaves the original atlas bytes
unchanged.

Restoring a pre-transition backup instead discards all progress since that
backup, including scores and cargo. It is a separate data-loss decision owned
by the human operator, not this rollback procedure. If the database or current
tile rows are invalid, the tool refuses; retain the database, WAL and verified
backups for investigation. Never substitute an empty atlas.
