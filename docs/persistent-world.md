# Persistent world operations

GeoRoids has one cooperative world with a 60,000-unit radius. It survives empty sessions and server restarts. There is currently no automatic world reset: a month-long run keeps its discoveries and depleted deposits.

## Active regions

The server generates deterministic ore deposits in 2,000-unit sectors. It activates sectors around connected pilots and the crew bots, and pauses distant sectors. Each client receives nearby asteroid, loot, and projectile rows, plus the shared crew roster and exploration changes. Returning to a harvested sector does not replenish its resources.

The local radar spans 3,600 units. Its 125-unit survey cells are permanent shared discoveries. Furnaces are fixed landmarks; a furnace appears on radar after the crew reveals its location. Surveyors passively explore farther and can scan a larger area. Scanned cargo records its Surveyor contributors until consumption, giving each the same full furnace reward as the Hauler.

## Database and credentials

`server/world/WorldStore.ts` uses SQLite with WAL and full synchronous transactions. The database stores world seed and start time, shared exploration, visited sector contents, and pilot progress. Ordinary flight and partial mining checkpoint every five seconds; terminal asteroid breaks, deliveries, score-bearing loot collections, successful loot blasts, new pilot credentials, and the final player's departure checkpoint immediately. Graceful shutdown checkpoints before closing the database. A hard crash can lose the uncheckpointed ordinary flight or partial-mining interval (normally about five seconds); a committed break or delivery consumes its world object and records its contributor scores in the same transaction.

A private random bearer token identifies a pilot. The browser stores it locally; the database stores its SHA-256 digest. A valid token restores progress after a browser reload or server restart. Offline Surveyors receive delivery credit on their next return. Clearing browser storage loses that credential. Names and public pilot IDs do not grant access to saved progress. Treat the database and browser credentials as private.

Asteroid impacts remove health, and deaths consume lives. Losing the final life ends that pilot's run. Play starts a new pilot with three lives and zero personal score; shared discoveries and the harvested world remain. A dead pilot's resume token cannot revive the old run.

The full-screen universe map shows shared exploration and revealed landmarks across the world. Detailed asteroid geometry stays near each pilot. Furnaces and exploration survive restarts. Dropped loot and satellite pickups remain transient session objects, so their map markers expire when those objects disappear or the server restarts.

Local development writes `.data/world.sqlite` by default. This directory and its journals are ignored by Git. `GEOROIDS_WORLD_PATH` overrides the location. The integration runner uses `:memory:` so tests cannot reset a developer's saved world. Direct server instances in tests are in-memory unless given a `worldPath`.

## Railway deployment and recovery

Production requires `GEOROIDS_WORLD_PATH=/data/world.sqlite` and the `world-data` volume mounted at `/data`. The tracked Railway definition prepares a 1 GB volume in `iad` and one server replica. Before opening the database, `server.ts` requires Railway's `RAILWAY_VOLUME_MOUNT_PATH` and checks that the absolute database path belongs directly in that directory. It rejects a missing mount, a different directory, or an in-memory database. Review and apply the volume/path plan before the first server deployment. This change does not apply infrastructure or deploy either service by itself.

Keep the database and its `-wal` and `-shm` files on that mounted volume. Enable daily and weekly volume backups in Railway and verify their live schedule after attaching the volume. For a manual copy, stop the service cleanly first or use SQLite's backup API; copying only the live database file can omit committed WAL transactions. Restore to the same path before starting the server. Invalid saved data stops startup instead of regenerating progress silently. A checkpoint failure blocks new gameplay, makes `/health` return 503, and reaches the fatal shutdown path on the next simulation tick, even when the world is paused. Shutdown closes resources without retrying the unacknowledged world mutation; the restart loads the last committed state.

Do not run multiple server replicas against the same world. The game loop has one authoritative writer; changing replica count requires a different world ownership design.
