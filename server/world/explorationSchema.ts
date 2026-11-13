import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { validExploration } from '../../shared/exploration';
import type { ExplorationTile } from '../../shared-types';
import { readSavedWorld, type SavedWorld } from './savedWorld';
import {
  canonicalSqliteTable,
  readSqliteCatalog,
  readSqliteTable,
  readSqliteText,
  type SqliteTableSnapshot,
  sqliteText,
} from './sqliteSnapshot';

type ExplorationStorageState = 'legacy' | 'prepared' | 'stale-preparation' | 'active';
type ExplorationTransition = 'prepare' | 'activate' | 'rollback';
const CREATE_TILE_TABLE = 'CREATE TABLE exploration (id TEXT PRIMARY KEY, bits TEXT NOT NULL)';

function hasTileTable(db: DatabaseSync): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='exploration'").get() !==
    undefined
  );
}

function savedWorldValue(db: DatabaseSync): { value: object; metadata: SavedWorld } | undefined {
  const rows = db.prepare('SELECT id,json,CAST(json AS BLOB) AS bytes FROM world').all();
  if (rows.length > 1 || (rows[0] && rows[0]['id'] !== 1)) {
    throw new Error('Invalid saved world rows');
  }
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  const json = readSqliteText(row['json'], row['bytes']);
  // JSON.parse selects the last duplicate key; SQLite JSON paths select the first.
  // Refuse ambiguous objects before either interpretation can authorize a write.
  if (
    db
      .prepare(
        "SELECT 1 FROM json_tree(?) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1 LIMIT 1"
      )
      .get(json)
  ) {
    throw new Error('Duplicate saved world JSON key');
  }
  const value: unknown = JSON.parse(json);
  const metadata = readSavedWorld(value);
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid saved world');
  }
  return { value, metadata };
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
  return readSqliteCatalog(db).filter((entry) => entry.tbl_name === table);
}

type StoredTiles =
  | { kind: 'absent' }
  | {
      kind: 'present';
      schema: ReturnType<typeof tableSchema>;
      table: SqliteTableSnapshot;
    };

function storedTiles(db: DatabaseSync): StoredTiles {
  return hasTileTable(db)
    ? {
        kind: 'present',
        schema: tableSchema(db, 'exploration'),
        table: readSqliteTable(db, 'exploration'),
      }
    : { kind: 'absent' };
}

function ownedStorage(db: DatabaseSync) {
  return {
    worldSchema: tableSchema(db, 'world'),
    world: readSqliteTable(db, 'world'),
    exploration: storedTiles(db),
  };
}

function worldWithJson(table: SqliteTableSnapshot, json: string): SqliteTableSnapshot {
  const index = table.columns.indexOf('json');
  const replace = (values: (typeof table.rows)[number]['values']) =>
    values.map((value, column) => (column === index ? sqliteText(json) : value));
  return table.kind === 'rowid'
    ? {
        ...table,
        rows: table.rows.map((row) => ({
          ...row,
          values: replace(row.values),
        })),
      }
    : {
        ...table,
        rows: table.rows.map((row) => ({
          ...row,
          values: replace(row.values),
        })),
      };
}

function rewrittenWorldJson(
  db: DatabaseSync,
  change: { kind: 'remove' } | { kind: 'restore'; tiles: ExplorationTile[] }
): string {
  const expression =
    change.kind === 'remove'
      ? "json_remove(json,'$.exploration')"
      : "json_set(json,'$.exploration',json(?))";
  const statement = db.prepare(
    `SELECT value,CAST(value AS BLOB) AS bytes FROM (SELECT ${expression} AS value FROM world WHERE id=1)`
  );
  const row =
    change.kind === 'remove' ? statement.get() : statement.get(JSON.stringify(change.tiles));
  return readSqliteText(row?.['value'], row?.['bytes']);
}

type TileReplacement =
  | {
      kind: 'rowid';
      table: Extract<SqliteTableSnapshot, { kind: 'rowid' }>;
      writes: { id: string; bits: string; rowid: bigint }[];
    }
  | {
      kind: 'without-rowid';
      table: Extract<SqliteTableSnapshot, { kind: 'without-rowid' }>;
      writes: ExplorationTile[];
    };

function tileReplacement(table: SqliteTableSnapshot, atlas: ExplorationTile[]): TileReplacement {
  const values = ({ id, bits }: ExplorationTile) =>
    table.columns.map((column) => sqliteText(column === 'id' ? id : bits));
  if (table.kind === 'without-rowid') {
    return {
      kind: 'without-rowid',
      writes: atlas,
      table: canonicalSqliteTable({
        ...table,
        rows: atlas.map((tile) => ({ values: values(tile) })),
      }),
    };
  }
  const idIndex = table.columns.indexOf('id');
  const existing = new Map(
    table.rows.map((row) => [JSON.stringify(row.values[idIndex]), row.rowid])
  );
  const used = new Set(table.rows.map((row) => row.rowid));
  let next = 1n;
  const writes = atlas.map((tile) => {
    const prior = existing.get(JSON.stringify(sqliteText(tile.id)));
    if (prior !== undefined) {
      return { ...tile, rowid: BigInt(prior) };
    }
    while (used.has(next.toString())) {
      next++;
    }
    const rowid = next++;
    used.add(rowid.toString());
    return { ...tile, rowid };
  });
  return {
    kind: 'rowid',
    writes,
    table: canonicalSqliteTable({
      ...table,
      rows: writes.map((tile) => ({
        rowid: tile.rowid.toString(),
        values: values(tile),
      })),
    }),
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
  const storage = readExplorationStorage(db);
  return { state: storage.state, tiles: storage.exploration.length };
}

/** One format owner for offline inspection, backup validation and runtime loading. */
export function readExplorationStorage(db: DatabaseSync): {
  state: ExplorationStorageState;
  world: SavedWorld | undefined;
  exploration: ExplorationTile[];
} {
  const saved = savedWorldValue(db);
  const world = saved?.value;
  const metadata = saved?.metadata;
  if (!hasTileTable(db)) {
    return { state: 'legacy', world: metadata, exploration: legacyTiles(world) };
  }
  const rows = tileRows(db);
  if (
    (world === undefined && rows.length === 0) ||
    (world !== undefined && !('exploration' in world))
  ) {
    return { state: 'active', world: metadata, exploration: rows };
  }
  const atlas = legacyTiles(world);
  if (!world && rows.length > 0) {
    throw new Error('Exploration rows have no world identity');
  }
  const expected = new Map(atlas.map(({ id, bits }) => [id, bits]));
  const matches =
    rows.length === atlas.length && rows.every(({ id, bits }) => expected.get(id) === bits);
  return {
    state: matches ? 'prepared' : 'stale-preparation',
    world: metadata,
    exploration: atlas,
  };
}

/** Hash all application tables and schema, including private rows, without printing their contents. */
export function explorationStorageFingerprint(
  db: DatabaseSync,
  excludedTables: readonly string[] = []
): string {
  const hash = createHash('sha256');
  const schema = readSqliteCatalog(db);
  for (const entry of schema) {
    if (excludedTables.includes(entry.tbl_name)) {
      continue;
    }
    hash.update(JSON.stringify(['schema', entry]));
    if (entry.type !== 'table') {
      continue;
    }
    hash.update(JSON.stringify(['table', entry.name, readSqliteTable(db, entry.name)]));
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
    const world = savedWorldValue(db)?.value;
    // Start from the complete owned state. Each branch changes only its declared
    // result before issuing SQL; one postcondition checks every row and schema.
    const expected = ownedStorage(db);
    if (action === 'prepare' && before.state !== 'active') {
      const previousTiles = expected.exploration;
      const atlas = legacyTiles(world).map(({ id, bits }) => ({ id, bits }));
      const plan = tileReplacement(
        previousTiles.kind === 'present'
          ? previousTiles.table
          : {
              kind: 'rowid',
              rowidColumn: 'rowid',
              columns: ['id', 'bits'],
              rows: [],
            },
        atlas
      );
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
        table: plan.table,
      };
      if (previousTiles.kind === 'absent') {
        db.exec(CREATE_TILE_TABLE);
      }
      db.exec('DELETE FROM exploration;');
      if (plan.kind === 'rowid') {
        const write = db.prepare('INSERT INTO exploration(rowid,id,bits) VALUES(?,?,?)');
        for (const { id, bits, rowid } of plan.writes) {
          write.run(rowid, id, bits);
        }
      } else {
        const write = db.prepare('INSERT INTO exploration(id,bits) VALUES(?,?)');
        for (const { id, bits } of plan.writes) {
          write.run(id, bits);
        }
      }
    } else if (action === 'activate' && before.state !== 'active') {
      if (before.state !== 'prepared') {
        throw new Error('Activation requires a current prepared exploration copy');
      }
      if (world && 'exploration' in world) {
        const json = rewrittenWorldJson(db, { kind: 'remove' });
        expected.world = worldWithJson(expected.world, json);
        db.prepare('UPDATE world SET json=? WHERE id=1').run(json);
      }
    } else if (action === 'rollback' && expected.exploration.kind === 'present') {
      const tiles = tileRows(db).map(({ id, bits }) => ({ id, bits }));
      expected.exploration = { kind: 'absent' };
      if (before.state === 'active' && world) {
        // Export current discoveries, including everything learned since activation.
        const json = rewrittenWorldJson(db, { kind: 'restore', tiles });
        expected.world = worldWithJson(expected.world, json);
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
