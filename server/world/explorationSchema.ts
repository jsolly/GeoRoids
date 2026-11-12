import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validExploration } from '../../shared/exploration';
import type { ExplorationTile } from '../../shared-types';
import { readSavedWorld } from './savedWorld';

type ExplorationStorageState = 'legacy' | 'prepared' | 'stale-preparation' | 'active';
type ExplorationTransition = 'prepare' | 'activate' | 'rollback';

function hasTileTable(db: DatabaseSync): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='exploration'").get() !==
    undefined
  );
}

function savedWorldValue(db: DatabaseSync): object | undefined {
  const row = db.prepare('SELECT json FROM world WHERE id=1').get();
  if (!row) {
    return undefined;
  }
  const value: unknown = JSON.parse(String(row['json']));
  readSavedWorld(value);
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid saved world');
  }
  return value;
}

function tileRows(db: DatabaseSync): ExplorationTile[] {
  const rows = db.prepare('SELECT id,bits FROM exploration ORDER BY id').all();
  if (!validExploration(rows)) {
    throw new Error('Invalid exploration rows');
  }
  return rows;
}

function legacyTiles(value: object | undefined): ExplorationTile[] {
  if (!value) {
    return [];
  }
  if (!('exploration' in value) || !validExploration(value.exploration)) {
    throw new Error('Invalid legacy exploration atlas');
  }
  return value.exploration;
}

/** Read-only inspection. A prepared copy may become stale while the old server runs. */
export function inspectExplorationStorage(db: DatabaseSync): {
  state: ExplorationStorageState;
  tiles: number;
} {
  const world = savedWorldValue(db);
  if (!hasTileTable(db)) {
    return { state: 'legacy', tiles: legacyTiles(world).length };
  }
  const rows = tileRows(db);
  if ((!world && rows.length === 0) || (world && !('exploration' in world))) {
    return { state: 'active', tiles: rows.length };
  }
  const atlas = legacyTiles(world);
  if (!world && rows.length > 0) {
    throw new Error('Exploration rows have no world identity');
  }
  const expected = new Map(atlas.map(({ id, bits }) => [id, bits]));
  const matches =
    rows.length === atlas.length && rows.every(({ id, bits }) => expected.get(id) === bits);
  return { state: matches ? 'prepared' : 'stale-preparation', tiles: atlas.length };
}

/** Hash all application tables and schema, including private rows, without printing their contents. */
export function explorationStorageFingerprint(
  db: DatabaseSync,
  excludedTables: readonly string[] = []
): string {
  const hash = createHash('sha256');
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    .all();
  for (const entry of schema) {
    if (typeof entry['tbl_name'] === 'string' && excludedTables.includes(entry['tbl_name'])) {
      continue;
    }
    hash.update(JSON.stringify(['schema', entry]));
    if (entry['type'] !== 'table' || typeof entry['name'] !== 'string') {
      continue;
    }
    const quoted = `"${entry['name'].replaceAll('"', '""')}"`;
    const rows = db
      .prepare(`SELECT * FROM ${quoted}`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
    for (const row of rows) {
      hash.update(JSON.stringify(['row', entry['name'], row]));
    }
  }
  return hash.digest('hex');
}

export function assertExplorationDatabaseIntegrity(db: DatabaseSync): void {
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (
    checks.length !== 1 ||
    checks[0]?.['integrity_check'] !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length > 0
  ) {
    throw new Error('Database integrity validation failed');
  }
}

/** Offline only. A fresh fingerprint is checked under the same lock as the atomic transition. */
export function transitionExplorationStorage(
  db: DatabaseSync,
  expectedFingerprint: string,
  action: ExplorationTransition
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (explorationStorageFingerprint(db) !== expectedFingerprint) {
      throw new Error('World changed since inspection');
    }
    const protectedFingerprint = explorationStorageFingerprint(db, ['world', 'exploration']);
    const before = inspectExplorationStorage(db);
    const world = savedWorldValue(db);
    let expectedWorldJson = db.prepare('SELECT json FROM world WHERE id=1').get()?.['json'];
    if (action === 'prepare' && before.state !== 'active') {
      const atlas = legacyTiles(world);
      db.exec(
        'CREATE TABLE IF NOT EXISTS exploration (id TEXT PRIMARY KEY, bits TEXT NOT NULL); DELETE FROM exploration;'
      );
      const write = db.prepare('INSERT INTO exploration(id,bits) VALUES(?,?)');
      for (const { id, bits } of atlas) {
        write.run(id, bits);
      }
    } else if (action === 'activate' && before.state !== 'active') {
      if (before.state !== 'prepared') {
        throw new Error('Activation requires a current prepared exploration copy');
      }
      if (world && 'exploration' in world) {
        const { exploration: _atlas, ...metadata } = world;
        expectedWorldJson = JSON.stringify(metadata);
        db.prepare('UPDATE world SET json=? WHERE id=1').run(expectedWorldJson);
      }
    } else if (action === 'rollback' && hasTileTable(db)) {
      if (before.state === 'active' && world) {
        // Export current discoveries, including everything learned since activation.
        expectedWorldJson = JSON.stringify({ ...world, exploration: tileRows(db) });
        db.prepare('UPDATE world SET json=? WHERE id=1').run(expectedWorldJson);
      }
      db.exec('DROP TABLE exploration');
    }
    const after = inspectExplorationStorage(db);
    if (
      (action === 'activate' && world && after.state !== 'active') ||
      (action === 'prepare' && after.state !== 'prepared' && after.state !== 'active') ||
      (action === 'rollback' && after.state !== 'legacy')
    ) {
      throw new Error('Exploration transition validation failed');
    }
    if (
      explorationStorageFingerprint(db, ['world', 'exploration']) !== protectedFingerprint ||
      db.prepare('SELECT json FROM world WHERE id=1').get()?.['json'] !== expectedWorldJson
    ) {
      throw new Error('Exploration transition changed unrelated saved data');
    }
    assertExplorationDatabaseIntegrity(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}
