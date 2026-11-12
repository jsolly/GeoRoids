import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { validExploration } from '../../shared/exploration';
import type { ExplorationTile } from '../../shared-types';
import { readSavedWorld } from './savedWorld';

type ExplorationStorageState = 'legacy' | 'prepared' | 'stale-preparation' | 'active';
type ExplorationTransition = 'prepare' | 'activate' | 'rollback';
const CREATE_TILE_TABLE = 'CREATE TABLE exploration (id TEXT PRIMARY KEY, bits TEXT NOT NULL)';

function hasTileTable(db: DatabaseSync): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='exploration'").get() !==
    undefined
  );
}

function savedWorldValue(db: DatabaseSync): object | undefined {
  const rows = db.prepare('SELECT id,json FROM world').all();
  if (rows.length > 1 || (rows[0] && rows[0]['id'] !== 1)) {
    throw new Error('Invalid saved world rows');
  }
  const row = rows[0];
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
  const columns = db.prepare('PRAGMA table_xinfo(exploration)').all();
  if (
    columns.length !== 2 ||
    !columns.some(
      (column) =>
        column['name'] === 'id' &&
        column['type'] === 'TEXT' &&
        column['pk'] === 1 &&
        column['hidden'] === 0
    ) ||
    !columns.some(
      (column) =>
        column['name'] === 'bits' &&
        column['type'] === 'TEXT' &&
        column['notnull'] === 1 &&
        column['pk'] === 0 &&
        column['hidden'] === 0
    )
  ) {
    throw new Error('Unsupported exploration schema');
  }
  const rows = db.prepare('SELECT id,bits FROM exploration ORDER BY id').all();
  if (!validExploration(rows)) {
    throw new Error('Invalid exploration rows');
  }
  return rows;
}

function tableSchema(db: DatabaseSync, table: 'world' | 'exploration') {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    .all(table)
    .map((row) => ({ ...row }));
}

type StoredTiles =
  | { kind: 'absent' }
  | { kind: 'present'; schema: ReturnType<typeof tableSchema>; rows: ExplorationTile[] };

function storedTiles(db: DatabaseSync): StoredTiles {
  return hasTileTable(db)
    ? {
        kind: 'present',
        schema: tableSchema(db, 'exploration'),
        rows: tileRows(db).map(({ id, bits }) => ({ id, bits })),
      }
    : { kind: 'absent' };
}

function ownedStorage(db: DatabaseSync) {
  return {
    worldSchema: tableSchema(db, 'world'),
    worldRows: db
      .prepare('SELECT * FROM world ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    exploration: storedTiles(db),
  };
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
    // Start from the complete owned state. Each branch changes only its declared
    // result before issuing SQL; one postcondition checks every row and schema.
    const expected = ownedStorage(db);
    if (action === 'prepare' && before.state !== 'active') {
      const previousTiles = expected.exploration;
      const atlas = legacyTiles(world)
        .map(({ id, bits }) => ({ id, bits }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      expected.exploration = {
        kind: 'present',
        schema:
          previousTiles.kind === 'present'
            ? previousTiles.schema
            : [
                {
                  type: 'table',
                  name: 'exploration',
                  tbl_name: 'exploration',
                  sql: CREATE_TILE_TABLE,
                },
              ],
        rows: atlas,
      };
      if (previousTiles.kind === 'absent') {
        db.exec(CREATE_TILE_TABLE);
      }
      db.exec('DELETE FROM exploration;');
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
        const json = JSON.stringify(metadata);
        expected.worldRows = expected.worldRows.map((row) => ({ ...row, json }));
        db.prepare('UPDATE world SET json=? WHERE id=1').run(json);
      }
    } else if (action === 'rollback' && expected.exploration.kind === 'present') {
      const tiles = expected.exploration.rows;
      expected.exploration = { kind: 'absent' };
      if (before.state === 'active' && world) {
        // Export current discoveries, including everything learned since activation.
        const json = JSON.stringify({ ...world, exploration: tiles });
        expected.worldRows = expected.worldRows.map((row) => ({ ...row, json }));
        db.prepare('UPDATE world SET json=? WHERE id=1').run(json);
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
      !isDeepStrictEqual(ownedStorage(db), expected)
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
