# Persistent world operations

GeoRoids has one cooperative world with a 60,000-unit radius. It survives empty sessions and server restarts until someone changes `WORLD.generation`. That change resets saved progress on the next server start so a new expedition can begin. A UTC month boundary does not.

## Active regions

The server generates deterministic ore deposits in 2,000-unit sectors. It activates sectors around connected pilots and pauses distant sectors. Each client receives asteroids inside its minimap radar plus a small margin (`WORLD.asteroidInterestRadius`), nearby loot and projectile rows, the shared crew roster, and exploration changes. Harvested deposits regrow out of sight (see below). Saved worlds store a generation number; a mismatch resets the database instead of loading stale progress.

The local radar spans 3,600 units. Its 125-unit survey cells are permanent shared discoveries. Town Square is the only hearth that starts lit. Dark furnace foundations stay on the universe map, and on the local radar while they are inside it. Lit hearths appear on the local radar after the crew reveals them. Built furnaces keep the Scout's name and the public id of the pilot who paid. They survive death, reconnects, and server restarts; changing `WORLD.generation` clears them on the next start. Scouts pay for a furnace with their own score. Every delivery contributor receives the same size-scaled material reward. The Town Square store sells placeholder receipts for banked points, gated by shared settlement level. Scouts passively explore farther and can scan a larger area. Scanned cargo records its Scout contributors until consumption.

## Database and credentials

## Deposit fields and regrowth

`server/world/depositLayout.ts` owns the deterministic layout. A continuous
two-scale value-noise field (`fieldRichness`) sets how many deposit slots each
sector owns, from `DEPOSIT_FIELD.VOID_DEPOSITS` in quiet voids to
`DEPOSIT_FIELD.PEAK_DEPOSITS` in rich field cores, and rejection sampling
places each slot along that field so clumps cross sector edges. Rich cores hold
more stationary rocks. Size, drift speed, spin, and outline vary per slot;
small rocks drift and spin faster and a few streak near the server speed limit.
Every property is a pure function of seed, sector, and slot index. The launch
neighborhood caps richness at `DEPOSIT_FIELD.LAUNCH_RICHNESS` inside
`LAUNCH_CALM_INNER`, blends to full strength by `LAUNCH_CALM_OUTER`, and has no
fast drifters, so new pilots start in a busy but survivable field. Generated
deposits skip the eastern belt's footprint so its rows keep clear lanes.

A slot regrows when its ID exists nowhere: not awake, not in any dormant
sector (an in-memory ID index answers this without scanning world history).
Each awake sector restores `DEPOSIT_FIELD.REGROWTH_FRACTION` of its missing
slots (at least one) per `DEPOSIT_FIELD.REGROWTH_INTERVAL_MS`, skipping slots
within `DEPOSIT_FIELD.REGROWTH_HIDDEN_DISTANCE` of any pilot or probe, so a
stripped field refills with a half-life of a few minutes. A sector that wakes
catches up on the intervals it slept through. A restart is not a refill: time
before the process started does not count, so saved sectors resume regrowing
from startup.
The regrown rock is the slot's original deposit: same ID, position, size, and
material. A world saved under an older layout keeps its surviving rocks and
fills missing slots the same way, so layout changes need no migration or reset.
Split fragments are not slots and never regrow.

Checkpoints send an awake sector every second when its set of rock IDs
changed (mined, regrown, or carried across an edge). Other asteroid state in
an unchanged sector (drift, spin, chip damage) is written every
`WORLD.driftFlushCheckpoints` checkpoints, so a hard crash can rewind rocks a
few seconds along their paths or undo a few seconds of chipping, but never
loses or duplicates a rock.

`server/world/WorldStore.ts` uses SQLite with WAL and full synchronous transactions, and the game loop never waits on it. The whole saved world is read once at startup and kept in memory; after that the loop only hands write batches to `server/world/WorkerWorldPersistence.ts`, whose worker thread owns the single writable connection (`server/world/worldStoreWorker.ts`). The integration runners' `:memory:` world cannot cross threads, so `openWorldPersistence` commits it inline instead. The database stores world seed, start time, generation, the server release that last wrote the world row, shared exploration, named furnaces, visited sector contents, and pilots (public id, last nickname, banked score, cargo, purchase receipts, silk, salvaged equipment, optional catalog hull paint, token digest, optional recent flight, and release stamps). A recent flight includes last-seen time, kit, pose, mass, and health. Existing saved mass and its flight rules remain intact; pickups no longer change mass or hull stats, and this change requires no saved-data migration. Returning to a recent flight releases contour lock; there is no stored charge or recharge timer. Each pilot row records which client and server releases issued the current resume token, which releases last wrote that score, and the server times of those writes. Live score writes also stamp the connected client. Server-only score writes (offline delivery credit) stamp the current server release and omit a client release so later migration can tell a browser was not present. Persistence is write-behind: once a second while the world is running, everything that changed since the last flush (moved or mined deposits, scores, credentials, exploration, and named furnaces) leaves the loop as one batch and is committed in one transaction, so a batch is never half-applied. Asteroid drift within an unchanged sector is the exception and follows the slower drift cadence described above. The final player's departure and graceful shutdown flush at once; shutdown waits for the last commit before the process exits, within a fixed budget inside Railway's ten-second SIGTERM window (1.5 s for an in-flight commit to finish, 3.5 s for the worker to commit and close). A writer that cannot keep that budget forfeits the final flush; the skipped flush is logged, and if the writer thread never releases the database (a thread inside a native SQLite call cannot be interrupted, and a normal exit would wait for it) the process ends itself with SIGKILL once the logs are flushed, so a hung disk can never hold a restart hostage. A hard crash therefore loses at most about the last second of play, including a terminal break, delivery, or loot pickup that had not been flushed yet; on restart the world resumes from the last committed batch and the clients rebase to it.

Furnace IDs retain their historical `street-<ring>-<slot>` addresses so existing saved sites and pipe routes stay intact. Builder names and public IDs remain construction attribution; they do not affect rewards.

Older world rows without `civicModules` load with only Town Square burning. A leftover `townCredit` value is ignored and dropped on the next world write. A leftover `litCivicLotIds` list loads as unnamed furnaces when `civicModules` is absent. A leftover `builtFurnaces` key is ignored and dropped on the next world write. A leftover `scoreSeason` key is ignored and dropped on the next world write. An illegal set of named furnaces fails startup rather than silently dropping them. A present `builderId` must be a short public pilot id; omitting it leaves an older unnamed furnace valid. Pilots may store `hullColor` only when it is a catalog paint hex. A non-string value rejects the pilot row. An unknown string is ignored. Purchased paint stays with the pilot across restarts. Building a furnace spends that Scout's score and changes memory only; the existing worker checkpoint writes the world row. A spatial index bounds local intake, spider-safety, and guidance lookups instead of scanning every saved structure.

A private bearer token restores banked points, cargo, purchase receipts, and
saved identity across reconnects and restarts. Recent healthy flights restore
pose; carrying cargo also preserves field position beyond the usual grace
period. Dead saved pilots get the normal respawn countdown. Existing `score`
values become banked points without a reset. Absent cargo and receipts default
to zero and an empty list. Old owned paint remains readable; lives are no longer
read or written. Unknown legacy JSON fields are harmless and no data is purged.

Asteroid impacts remove health. Death drops carried points and schedules another respawn; banked points, shared discoveries, deposits, furnaces, and already owned hull paint remain. A UTC month boundary does not clear them. Changing `WORLD.generation` resets sectors, pilots, economy, paint, and banked points on the next start.

The full-screen universe map shows shared exploration and revealed landmarks across the world. Detailed asteroid geometry stays near each pilot. Furnaces and exploration survive restarts. Point drops persist in the economy checkpoint with their original expiry time. Other loot and satellite pickups remain transient session objects, so their map markers expire when those objects disappear or the server restarts.

Asteroid boost couplings are stored with their deposit. Ignited couplings retain their original owner and resume guidance to the nearest furnace after restart. Their sectors stay awake until delivery. Guidance pauses when the world has no players. Legacy saved finite burns had no owner ID; the storage loader cancels only that propulsion, preserving the deposit and its momentum. New snapshots require an owner ID for ignited cargo, so deploy the server and client together and refresh older clients. Armed couplings lose their owner when the live attachment ends and clear before the next motion step; disconnect and removal clear them immediately.

Local development writes `.data/world.sqlite` by default. This directory and its journals are ignored by Git. `GEOROIDS_WORLD_PATH` overrides the location. The integration runner uses `:memory:` so tests cannot reset a developer's saved world. Direct server instances in tests are in-memory unless given a `worldPath`.

## Railway deployment and recovery

Production requires `GEOROIDS_WORLD_PATH=/data/world.sqlite` and the `world-data` volume mounted at `/data`. The tracked Railway definition prepares a 1 GB volume in `iad` and one server replica. Before opening the database, `server.ts` requires Railway's `RAILWAY_VOLUME_MOUNT_PATH` and checks that the absolute database path belongs directly in that directory. It rejects a missing mount, a different directory, or an in-memory database. Review and apply the volume/path plan before the first server deployment. This change does not apply infrastructure or deploy either service by itself.

Keep the database and its `-wal` and `-shm` files on that mounted volume. Enable daily and weekly volume backups in Railway and verify their live schedule after attaching the volume. For a manual copy, stop the service cleanly first or use SQLite's backup API; copying only the live database file can omit committed WAL transactions. Restore to the same path before starting the server. Invalid saved data stops startup instead of regenerating progress silently. A failed commit, reported back from the worker, blocks new gameplay, makes `/health` return 503, and reaches the fatal shutdown path on the next simulation tick, even when the world is paused. Shutdown closes resources without retrying the unacknowledged world mutation; the restart loads the last committed state. `/health` also reports `world.loop` (discarded simulation debt, longest stall, stall count) and `world.persistence` (pending and committed batches, last commit time); a clock step blocked for 250 ms or more logs `game_loop_stalled`.

Do not run multiple server replicas against the same world. The game loop has one authoritative writer; changing replica count requires a different world ownership design.

## Asteroid belt recovery

The world row stores a finite `asteroidBelt` ledger with a generation and
absolute recovery deadline per belt location. Existing worlds receive the new
belt additively; ordinary deposits regrow through their own slots. Destroying a belt
host or carrying it away starts the configured five-minute timer. The deadline
continues through pauses, sleeping sectors and restarts; due deposits are
reconstructed in memory when the simulation reconciles the belt. Replacement
IDs include a generation, so old cargo remains independent of its replacement.
The final ten seconds are announced in snapshots as `beltRecovery` warnings.

Attached crawler health is stored as `beltCrawlerHealth`, with persistent
identities in the parallel `beltCrawlerIds` array. A pursuit hop or successful escape moves
ownership and remaining health to the destination before the animation starts,
so a restart cannot duplicate or heal the moving spider. Vacated native slots do not spawn replacement guards.
Transfers reuse dead occupant slots so repeated hops do not grow saved arrays. Sleeping sectors do not
trigger escape. Crawl positions and leap/lunge phases are transient; a reload
resumes the spider attached to its saved host.
Belt reconciliation examines only the fixed belt locations and nearby sectors,
never the saved world's full sector history, and uses the existing worker
checkpoint batch. The usual hard-crash write-behind loss window still applies.

## Scout rename

The former Surveyor kit is now Scout, including the `scout` network ID and
`scoutUtility` field. On opening the database, the server rewrites saved pilot
kit IDs from `surveyor` to `scout` before validating their flight state. Scores,
positions, inventory and resume credentials remain intact. The client migrates
the saved utility preference to `georoids.scoutUtility`.

Deploy the server and client together for this protocol change; old clients
must reload. The previous server cannot interpret the migrated Scout flight
IDs, so rolling back requires restoring the pre-deploy database backup.

## Economy persistence

An additive `economy` row stores settlement balances and expiring point stashes.
It commits atomically with pilots and consumed asteroid sectors in the existing
worker transaction. Cargo deposits and death drops therefore cannot be half
committed. Point-drop updates do not resend the explored world. Absolute expiry
timestamps prevent restarting the server from extending recovery time. Old
worlds default to settlement level 1 with zero shared points/materials; existing
banks and furnaces are retained. Whole-database SQLite backups include this row.
