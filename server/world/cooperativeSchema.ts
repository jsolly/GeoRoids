import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { COOPERATIVE } from '../../shared/cooperativeRules';
import { validCooperativeRecord } from '../../shared/cooperativeWorld';
import type { CooperativeRecord, CooperativeWorld } from '../../shared-types';

/** Read-only schema and row inspection. Ordinary startup never creates these tables. */
export function readCooperativeWorld(db: DatabaseSync): CooperativeWorld | undefined {
  const activated = readCooperativeSchema(db);
  if (activated === undefined) {
    return undefined;
  }
  return { schemaVersion: 1, activated, records: [...iterateCooperativeRecords(db)] };
}

/** Shared read-only marker validation; false means a prepared, inactive schema. */
export function readCooperativeSchema(db: DatabaseSync): boolean | undefined {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cooperative_schema','cooperative_records')"
    )
    .all();
  if (tables.length === 0) {
    return undefined;
  }
  if (tables.length !== 2) {
    throw new Error('Incomplete cooperative schema');
  }
  const markers = db.prepare('SELECT version,activated FROM cooperative_schema LIMIT 2').all();
  const marker = markers[0];
  if (
    markers.length !== 1 ||
    marker?.['version'] !== COOPERATIVE.schemaVersion ||
    (marker['activated'] !== 0 && marker['activated'] !== 1)
  ) {
    throw new Error('Unsupported cooperative schema');
  }
  return marker['activated'] === 1;
}

/** Iterate validation without loading a second campaign into the backup process. */
export function* iterateCooperativeRecords(db: DatabaseSync): Generator<CooperativeRecord> {
  for (const row of db.prepare('SELECT id,json FROM cooperative_records ORDER BY id').iterate()) {
    const value: unknown = JSON.parse(String(row['json']));
    if (!validCooperativeRecord(value) || `${value.kind}:${value.id}` !== row['id']) {
      throw new Error(`Invalid cooperative record ${String(row['id'])}`);
    }
    yield value;
  }
}

/** Fingerprint the exact legacy data, including credentials, without exposing it. */
export function legacyWorldDigest(db: DatabaseSync): string {
  const hash = createHash('sha256');
  for (const name of ['world', 'sectors', 'economy', 'pilots']) {
    hash.update(name);
    // Table names are a constant allowlist; only values reach the hash.
    for (const row of db.prepare(`SELECT id,json FROM ${name} ORDER BY id`).all()) {
      hash.update(JSON.stringify([row['id'], row['json']]));
    }
  }
  return hash.digest('hex');
}

/** Called only by the offline migration tool and isolated fixtures. Never by server startup. */
export function migrateCooperativeWorld(db: DatabaseSync, expectedLegacyDigest: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (legacyWorldDigest(db) !== expectedLegacyDigest) {
      throw new Error('Legacy world changed since inspection');
    }
    const existing = readCooperativeWorld(db);
    if (!existing) {
      db.exec(`CREATE TABLE cooperative_schema (version INTEGER PRIMARY KEY CHECK(version=1), activated INTEGER NOT NULL CHECK(activated IN (0,1)));
        CREATE TABLE cooperative_records (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        INSERT INTO cooperative_schema(version,activated) VALUES(1,0);`);
    }
    if (legacyWorldDigest(db) !== expectedLegacyDigest) {
      throw new Error('Migration changed legacy world');
    }
    readCooperativeWorld(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}
