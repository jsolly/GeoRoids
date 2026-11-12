/* @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import {
  explorationStorageFingerprint,
  inspectExplorationStorage,
  transitionExplorationStorage,
} from '../../../server/world/explorationSchema';
import { WorldStore } from '../../../server/world/WorldStore';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});
const atlas = [
  { id: '30,30', bits: `03${'00'.repeat(31)}` },
  { id: '7,12', bits: `${'00'.repeat(31)}80` },
];
function worldFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'georoids-exploration-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'world.sqlite');
}
function legacyFixture() {
  const path = worldFile();
  const db = new DatabaseSync(path);
  cleanups.push(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(
    readFileSync(new URL('../../fixtures/exploration-legacy-world.sql', import.meta.url), 'utf8')
  );
  return { path, db };
}
function transition(db: DatabaseSync, action: 'prepare' | 'activate' | 'rollback'): void {
  transitionExplorationStorage(db, explorationStorageFingerprint(db), action);
}
function rawWorld(db: DatabaseSync): string {
  return String(db.prepare('SELECT json FROM world WHERE id=1').get()?.['json']);
}
function otherRows(db: DatabaseSync) {
  return ['sectors', 'pilots', 'economy'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
  );
}

function loadWithLegacyReader(path: string) {
  const store = new WorldStore(path);
  try {
    return store.load();
  } finally {
    store.close();
  }
}

test('preparing the captured old schema preserves the old reader, activation retains every discovery, and rollback exports new discoveries', () => {
  const { path, db } = legacyFixture();
  const legacy = loadWithLegacyReader(path);
  const before = rawWorld(db);
  const otherBefore = otherRows(db);
  expect(inspectExplorationStorage(db)).toEqual({ state: 'legacy', tiles: 2 });
  transition(db, 'prepare');
  expect(rawWorld(db)).toBe(before);
  expect(loadWithLegacyReader(path)).toEqual(legacy);
  expect(inspectExplorationStorage(db)).toEqual({ state: 'prepared', tiles: 2 });
  const prepared = explorationStorageFingerprint(db);
  transition(db, 'prepare');
  expect(explorationStorageFingerprint(db)).toBe(prepared);
  transition(db, 'activate');
  const activated = explorationStorageFingerprint(db);
  transition(db, 'activate');
  expect(explorationStorageFingerprint(db)).toBe(activated);
  expect(JSON.parse(rawWorld(db))).not.toHaveProperty('exploration');
  expect(() => loadWithLegacyReader(path)).toThrow('Saved world is invalid');
  expect(db.prepare('SELECT id,bits FROM exploration').all()).toEqual(atlas);
  db.prepare('INSERT INTO exploration(id,bits) VALUES(?,?)').run('31,30', `04${'00'.repeat(31)}`);
  transition(db, 'rollback');
  expect(inspectExplorationStorage(db)).toEqual({ state: 'legacy', tiles: 3 });
  expect(JSON.parse(rawWorld(db)).exploration).toEqual(
    expect.arrayContaining([...atlas, { id: '31,30', bits: `04${'00'.repeat(31)}` }])
  );
  expect(otherRows(db)).toEqual(otherBefore);
  const restored = loadWithLegacyReader(path);
  expect(restored.world?.exploration).toEqual(
    expect.arrayContaining([...atlas, { id: '31,30', bits: `04${'00'.repeat(31)}` }])
  );
  expect(restored.pilots).toEqual(legacy.pilots);
  expect(restored.economy).toEqual(legacy.economy);
  expect(restored.sectors).toEqual(legacy.sectors);
  const rolledBack = explorationStorageFingerprint(db);
  transition(db, 'rollback');
  expect(explorationStorageFingerprint(db)).toBe(rolledBack);
});

test('an old writer can make preparation stale, which blocks activation until the stopped world is prepared again', () => {
  const { db } = legacyFixture();
  transition(db, 'prepare');
  const receipt = explorationStorageFingerprint(db);
  const world = JSON.parse(rawWorld(db));
  world.exploration[0].bits = `07${'00'.repeat(31)}`;
  world.retainedLegacyField = { answer: 42 };
  db.prepare('UPDATE world SET json=?').run(JSON.stringify(world));
  const changed = explorationStorageFingerprint(db);
  expect(() => transitionExplorationStorage(db, receipt, 'activate')).toThrow(
    'changed since inspection'
  );
  expect(inspectExplorationStorage(db).state).toBe('stale-preparation');
  expect(() => transition(db, 'activate')).toThrow('current prepared');
  expect(explorationStorageFingerprint(db)).toBe(changed);
  transition(db, 'prepare');
  transition(db, 'activate');
  expect(db.prepare('SELECT bits FROM exploration WHERE id=?').get('30,30')?.['bits']).toBe(
    `07${'00'.repeat(31)}`
  );
  expect(JSON.parse(rawWorld(db)).retainedLegacyField).toEqual({ answer: 42 });
});

test('activation failure rolls back the world rewrite, and malformed legacy discovery data never gets normalized', () => {
  const { db } = legacyFixture();
  transition(db, 'prepare');
  db.exec(
    "CREATE TRIGGER refuse_activation BEFORE UPDATE ON world BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;"
  );
  const before = explorationStorageFingerprint(db);
  expect(() => transition(db, 'activate')).toThrow('fixture disk failure');
  expect(explorationStorageFingerprint(db)).toBe(before);
  expect(db.isTransaction).toBe(false);
  db.exec('DROP TRIGGER refuse_activation; DROP TABLE exploration;');
  const world = JSON.parse(rawWorld(db));
  world.exploration[0].bits = 'invalid';
  db.prepare('UPDATE world SET json=?').run(JSON.stringify(world));
  const invalid = explorationStorageFingerprint(db);
  expect(() => transition(db, 'prepare')).toThrow('Invalid legacy exploration');
  expect(explorationStorageFingerprint(db)).toBe(invalid);
});

test('CLI dry-run is read-only, backups include committed WAL, stale receipts and reused backup paths fail, and receipts expose no pilot data', () => {
  const { path, db } = legacyFixture();
  const cli = (...args: string[]) =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/migrate-exploration-storage.ts', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  const before = explorationStorageFingerprint(db);
  const output = cli('dry-run', path);
  expect(JSON.parse(output)).toMatchObject({
    fingerprint: before,
    before: { state: 'legacy', tiles: 2 },
  });
  expect(output).not.toContain('Captain');
  expect(output).not.toContain('a'.repeat(64));
  expect(explorationStorageFingerprint(db)).toBe(before);
  const backupPath = join(dirname(path), 'before-prepare.sqlite');
  expect(() => cli('prepare', path, 'wrong', backupPath)).toThrow();
  expect(JSON.parse(cli('prepare', path, before, backupPath))).toMatchObject({
    after: { state: 'prepared' },
  });
  expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    expect(explorationStorageFingerprint(backup)).toBe(before);
    expect(rawWorld(backup)).toBe(rawWorld(db));
    expect(otherRows(backup)).toEqual(otherRows(db));
  } finally {
    backup.close();
  }
  const prepared = explorationStorageFingerprint(db);
  expect(() => cli('activate', path, prepared, backupPath)).toThrow();
  expect(explorationStorageFingerprint(db)).toBe(prepared);
  const emptyBackup = join(dirname(path), 'existing-empty.sqlite');
  writeFileSync(emptyBackup, '');
  expect(() => cli('activate', path, prepared, emptyBackup)).toThrow();
  expect(statSync(emptyBackup).size).toBe(0);
  expect(explorationStorageFingerprint(db)).toBe(prepared);
  expect(
    JSON.parse(cli('activate', path, prepared, join(dirname(path), 'before-activate.sqlite')))
  ).toMatchObject({ after: { state: 'active' } });
});

test('a failed prepared-copy refresh leaves the original copy and old world intact', () => {
  const { db } = legacyFixture();
  transition(db, 'prepare');
  db.exec(
    "CREATE TRIGGER refuse_tile BEFORE INSERT ON exploration BEGIN SELECT RAISE(ABORT,'fixture tile failure'); END;"
  );
  const before = explorationStorageFingerprint(db);
  expect(() => transition(db, 'prepare')).toThrow('fixture tile failure');
  expect(explorationStorageFingerprint(db)).toBe(before);
  expect(inspectExplorationStorage(db).state).toBe('prepared');
  expect(db.isTransaction).toBe(false);
});

test('a trigger that changes pilot progress makes activation fail and rolls every row back', () => {
  const { db } = legacyFixture();
  transition(db, 'prepare');
  db.exec(
    "CREATE TRIGGER corrupt_pilot AFTER UPDATE ON world BEGIN UPDATE pilots SET json='{}'; END;"
  );
  const before = explorationStorageFingerprint(db);
  expect(() => transition(db, 'activate')).toThrow('unrelated saved data');
  expect(explorationStorageFingerprint(db)).toBe(before);
});

test('moving a schema-shaped auxiliary row between tables invalidates the inspection fingerprint', () => {
  const { db } = legacyFixture();
  db.exec(`CREATE TABLE auxiliary_a (type TEXT, name TEXT, tbl_name TEXT, sql TEXT);
    CREATE TABLE auxiliary_b (type TEXT, name TEXT, tbl_name TEXT, sql TEXT);
    INSERT INTO auxiliary_a SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='auxiliary_b';`);
  const before = explorationStorageFingerprint(db);
  db.exec(`DELETE FROM auxiliary_a;
    INSERT INTO auxiliary_b SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='auxiliary_b';`);
  expect(explorationStorageFingerprint(db)).not.toBe(before);
  expect(() => transitionExplorationStorage(db, before, 'prepare')).toThrow(
    'changed since inspection'
  );
  expect(inspectExplorationStorage(db).state).toBe('legacy');
});

test('a world trigger cannot change a retained column while activation removes the atlas', () => {
  const { db } = legacyFixture();
  db.exec("ALTER TABLE world ADD COLUMN retained TEXT NOT NULL DEFAULT 'keep';");
  transition(db, 'prepare');
  db.exec(
    "CREATE TRIGGER change_retained AFTER UPDATE ON world BEGIN UPDATE world SET retained='lost'; END;"
  );
  const before = explorationStorageFingerprint(db);
  expect(() => transition(db, 'activate')).toThrow('unrelated saved data');
  expect(explorationStorageFingerprint(db)).toBe(before);
  expect(db.prepare('SELECT retained FROM world').get()?.['retained']).toBe('keep');
  expect(inspectExplorationStorage(db).state).toBe('prepared');
});

test.each([
  {
    name: 'an extra retained column',
    columns: 'id TEXT PRIMARY KEY, bits TEXT NOT NULL, retained TEXT',
  },
  { name: 'a missing tile primary key', columns: 'id TEXT, bits TEXT NOT NULL' },
  { name: 'nullable tile bits', columns: 'id TEXT PRIMARY KEY, bits TEXT' },
])('preparing exploration with $name refuses before changing data', ({ name, columns }) => {
  const { db } = legacyFixture();
  db.exec(`CREATE TABLE exploration (${columns});`);
  const write = db.prepare('INSERT INTO exploration(id,bits) VALUES(?,?)');
  for (const { id, bits } of atlas) {
    write.run(id, bits);
  }
  if (name === 'an extra retained column') {
    db.exec("UPDATE exploration SET retained='saved-progress';");
  }
  const before = explorationStorageFingerprint(db);
  expect(() => transition(db, 'prepare')).toThrow('Unsupported exploration schema');
  expect(explorationStorageFingerprint(db)).toBe(before);
});

test('an ambiguous world table refuses preparation instead of choosing one world to migrate', () => {
  const { db } = legacyFixture();
  db.exec(`ALTER TABLE world RENAME TO old_world;
    CREATE TABLE world (id INTEGER, json TEXT NOT NULL);
    INSERT INTO world SELECT id,json FROM old_world;
    INSERT INTO world SELECT id,json_set(json,'$.seed',84) FROM old_world;
    DROP TABLE old_world;`);
  const before = explorationStorageFingerprint(db);
  expect(() => transition(db, 'prepare')).toThrow('Invalid saved world rows');
  expect(explorationStorageFingerprint(db)).toBe(before);
});

test.each([
  { name: 'delete', statement: "DELETE FROM exploration WHERE id='7,12';" },
  {
    name: 'rewrite',
    statement: `UPDATE exploration SET bits='${'ff'.repeat(32)}' WHERE id='7,12';`,
  },
])('activation refuses a world trigger that can $name discovery rows', ({ statement }) => {
  const { db } = legacyFixture();
  transition(db, 'prepare');
  db.exec(`CREATE TRIGGER change_tiles AFTER UPDATE ON world BEGIN ${statement} END;`);
  const before = explorationStorageFingerprint(db);
  expect(() => transition(db, 'activate')).toThrow('unrelated saved data');
  expect(explorationStorageFingerprint(db)).toBe(before);
  expect(inspectExplorationStorage(db)).toEqual({ state: 'prepared', tiles: 2 });
});
