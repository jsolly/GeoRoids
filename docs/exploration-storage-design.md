# Exploration checkpoint ownership

This is the Phase 2 runtime contract. Phase 1 publishes the offline transition
tooling only; the deployed reader and writer continue using the legacy atlas.

`ExplorationMap.reveal` updates one immutable hex string per changed tile and
records it in a dirty map. `checkpoint()` copies only that map. `saved(batch)`
removes a dirty entry only if its value still matches the accepted batch.
`GameEngine.checkpointWorld` sends these tiles alongside sectors, pilots and
economy. `WorldStore` validates and writes them inside the existing transaction.
SQLite validation, JSON encoding and fsync run in the writer thread in production.
The main thread copies only the bounded dirty batch and uses the existing worker
structured clone. It neither scans the saved atlas nor reads/writes SQLite.

A successful handover transfers ownership to the adapter. Discoveries made while
it commits accumulate in the next dirty batch. The engine coalesces checkpoints
until that adapter becomes idle. A synchronous handover failure does not clear
the batch. An asynchronous commit failure is fatal, as before: the engine stops
trusting live memory and restarts from the last durable transaction. It does not
retry an unacknowledged batch against newer live state.

`SavedWorld` contains world metadata. `LoadedWorld.exploration` is loaded once
from `exploration(id TEXT PRIMARY KEY, bits TEXT NOT NULL)`. The worker protocol
carries `WorldCheckpoint.exploration`, a read-only map of tile id to hex string.
Snapshot encoding still uses `ExplorationMap.snapshot()` and the existing atlas
collection/delta protocol. Client behavior and generation reset rules do not
change. The database reset clears tile rows in the same transaction as the rest
of the expedition. Diagnostic world replacement sends an explicit
`resetExploration` command, which clears rows in the worker transaction before
applying that checkpoint's new discoveries.

The alternatives considered for this change were:

- Keep the atlas JSON and patch it in SQLite. This retains growing world-row
  serialization, whole-value writes and coupling between furnace metadata and
  exploration.
- Move all exploration ownership into the worker and send cell events. This
  removes the main-thread copy but adds a second authoritative map, ordered
  event replay and new snapshot ownership. It changes more than storage.
- Keep authoritative memory on the game thread and persist dirty tile values.
  This uses the existing worker/transaction boundary, bounds checkpoint work by
  changed tiles and gives later transport work an independent dirty tracker.
  This is the implemented design.

Commit `885acc22` explains why `snapshot()` lazily rebuilds the atlas rather than
`reveal()` doing it on every pilot's frame. This change preserves that network
contract and removes the persistence reader that previously requested that
whole atlas once a second. `docs/persistent-world.md` owns the existing fatal
commit, backup, generation and single-writer constraints.
