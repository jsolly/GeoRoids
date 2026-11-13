# Exploration runtime rollout

Publication is on hold until the stopped-world transition and recovery operations
are separately approved. Merging source deploys the server through Git, so do not
publish the active-only reader against a live legacy world.

## Storage and write ownership

`savedWorld.ts` owns metadata parsing, and `worldDataValidation.ts` owns pilot,
sector and economy parsing. `explorationSchema.ts` is the single format reader
for runtime, offline transitions and backup inspection. Legacy, prepared and
stale-preparation storage uses the legacy atlas as authority. Only active storage
uses tile rows. Inspection never changes that authority or constructs WorldStore.

ExplorationMap owns memory and persistence dirtiness. Reveal changes one immutable
hex string per tile. Checkpoint copies only dirty entries; successful synchronous
adapter handover removes an entry only while its value still matches. The worker's
structured clone or inline transaction must accept the batch before handover
returns. That is ownership transfer, not a durable acknowledgement.

The worker transaction commits tile UPSERTs with sectors, pilots, economy and
metadata. A diagnostic replacement deletes tiles before its new values in the
same transaction, including an intentionally empty replacement. Explicit private
reset clears tiles with the other world tables and stays ordered after previously
accepted batches. A failed transaction makes the adapter fail permanently; the
engine stops and restarts from durable state. It never retries an ambiguous batch
against later live discoveries.

The ordinary frame retains one asteroid motion pass and the existing maintenance
copy count. There are no database calls or atlas scans in reveal or ordinary
simulation. The shipped Atlas transport keeps its independent per-recipient cursor and map
identity. A snapshot offer/successful send, client application ACK, synchronous
storage handover and SQL durability are four distinct states. Transport ACKs never
consume persistence dirtiness, and storage acceptance never advances a recipient's
cursor or changes the Atlas epoch/index.

## Compatibility proof

The manual lever runs a real pinned old reader/writer and the candidate through
one synthetic disposable database. It copies source trees into a new private
directory, verifies their digest and uses the real consumers in separate processes.
It makes no Git or network lookup. From the candidate checkout:

```sh
node --import tsx scripts/verify-exploration-reader-transition.ts inspect /absolute/pinned-legacy-source
node scripts/validation-admission.mjs unit -- node --import tsx scripts/verify-exploration-reader-transition.ts run /absolute/pinned-legacy-source SOURCE_SHA256 /absolute/new-compatibility-directory
```

For this integration the shipped Atlas source anchor is
`b416d23c1f6fb3c295936591dbe88cc35c15ac7d`. Rerun the compatibility lever against
that actual published legacy runtime in a separately pinned extraction; the prior
400 preparation receipt does not certify this integrated candidate.

Pin the actual published legacy revision and record its source digest. A reviewed
preparation branch is useful development evidence but is not a deployed-release
certificate. The retained receipt proves old writes, byte-identical preparation,
stale-copy rejection, active old-reader rejection, real candidate worker commit
and restart, then rollback export reopened by the real old reader. It compares
every atlas id/bits and hashes the synthetic pilot/economy/sector/identity state.
The lever never retains an unused legacy production API in the candidate.

The separate causal regression lever introduces one controlled defect at a time,
requires the selected assertion to fail, then restores the source bytes and checks
their hashes in `finally`. Run it only in an exclusively owned disposable candidate
checkout, with no gate or other reader of that checkout running:

```sh
node scripts/validation-admission.mjs unit -- node --import tsx scripts/verify-exploration-checkpoint-mutants.ts /absolute/new-mutant-evidence
```

Its receipt covers newer dirty values, worker tile handover, existing-tile UPSERT,
saved generation, opaque metadata, transaction rollback, reset/replacement deletes
and acceptance ordering. These deliberate failures never count as a passing full
gate. Remove every mutation and run ordinary focused tests before publication.

## Recovery and activation prerequisites

1. Complete source review, focused regressions, the full local gate and exact-head
   independent change/security review. Reconcile landed phase1 and backup source.
2. Obtain approval for recovery resources and credentials, a fresh consistent real
   legacy snapshot off the world volume, verified retained recovery points, and an
   actual isolated restore. Code approval does not authorize these operations.
3. Rehearse prepare, activation, candidate boot, a real new tile checkpoint,
   shutdown/restart durability and rollback export against an isolated copy.
   Retain the original downloaded artifact unchanged. Backup inspection supports
   all four formats; an inspectable legacy artifact cannot boot the active-only
   runtime until its separate isolated transition has been explicitly performed.
4. In the separately approved maintenance window, stop and close the old writer
   and prevent automatic restart. Inspect, refresh prepare with fresh fingerprints
   and new verified backup paths, activate and require active state. Do not run two
   writers. Publish only the reviewed exact candidate that can follow activation.
5. Verify the real release, join, unchanged map and progress, a new worker-committed
   tile, health and restart durability. If deployment cannot complete, export
   rollback before restarting the old reader. Never start an old writer on active
   rows or let startup migrate/reset production.

Actual production operations, off-volume copies, restores, activation and recurring
backup enablement remain human-owned. An architecture document, unit fixture or
green code build does not complete the original production outcome.
