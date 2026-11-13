/* @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import {
  legacyWorldDigest,
  migrateCooperativeWorld,
  readCooperativeWorld,
} from '../../../server/world/cooperativeSchema';
import { WorkerWorldPersistence } from '../../../server/world/WorkerWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { CIVIC_LOTS } from '../../../shared/furnaces';
import { WORLD } from '../../../shared/world';
import { snapshotFixture } from '../network/snapshotFixture';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});
function legacyRows(db: DatabaseSync) {
  return {
    world: db.prepare('SELECT id,json FROM world ORDER BY id').all(),
    sectors: db.prepare('SELECT id,json FROM sectors ORDER BY id').all(),
    economy: db.prepare('SELECT id,json FROM economy ORDER BY id').all(),
    pilots: db.prepare('SELECT id,json FROM pilots ORDER BY id').all(),
  };
}

function legacyFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'georoids-cooperative-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'world.sqlite');
  const store = new WorldStore(path, { intent: 'private' });
  const rock = snapshotFixture().asteroids[0];
  if (!rock) {
    throw new Error('Fixture asteroid missing');
  }
  store.checkpoint(
    {
      seed: 83,
      generation: WORLD.generation,
      startedAt: 10_000,

      civicModules: CIVIC_LOTS.map((lot) => ({ id: lot.id, builderName: 'Crew' })),
    },
    new Map([
      ['0,0', [{ ...rock, id: 'mined-metal', position: { x: 20, y: 20 }, health: 17 }]],
      [
        '1,0',
        [
          {
            ...rock,
            id: 'surveyed-ice',
            position: { x: 2_100, y: 30 },
            material: 'ice',
            surveyedBy: ['pilot'],
            miningContributors: ['pilot'],
          },
        ],
      ],
    ]),
    [
      {
        id: 'pilot',
        name: 'Captain',
        tokenHash: 'a'.repeat(64),
        score: 7300,
        cargo: 715,
        purchases: [],
      },
    ],
    {
      settlement: {
        level: 3,
        points: 440,
        resources: { ice: 11, metal: 22, rubble: 33, crystal: 4 },
      },
      pointLoot: [
        {
          id: 'recoverable-bank',
          position: { x: 120, y: 80 },
          points: 315,
          expiresAt: 130_000,
          velocity: { x: 2, y: -1 },
          ejectFramesLeft: 12,
        },
      ],
    },
    undefined,
    {
      kind: 'patch',
      tiles: new Map(
        [{ id: '30,30', bits: `03${'00'.repeat(31)}` }].map(({ id, bits }) => [id, bits])
      ),
    }
  );
  store.close();
  const db = new DatabaseSync(path);
  cleanups.push(() => db.close());
  const before = legacyRows(db);
  expect(before.world).toHaveLength(1);
  expect(before.sectors.map((row) => row['id'])).toEqual(['0,0', '1,0']);
  expect(before.economy).toHaveLength(1);
  expect(before.pilots).toHaveLength(1);
  return { path, db, before };
}

test('additive migration preserves exact legacy rows, stays inactive and reruns safely', () => {
  const { db, path, before } = legacyFixture();
  const digest = legacyWorldDigest(db);
  expect(readCooperativeWorld(db)).toBeUndefined();
  migrateCooperativeWorld(db, digest);
  expect(legacyRows(db)).toEqual(before);
  migrateCooperativeWorld(db, digest);
  expect(legacyRows(db)).toEqual(before);
  expect(legacyWorldDigest(db)).toBe(digest);
  expect(readCooperativeWorld(db)).toEqual({ schemaVersion: 1, activated: false, records: [] });
  const store = new WorldStore(path, { intent: 'private' });
  try {
    const loaded = store.load();
    expect(loaded.pilots[0]).toMatchObject({ cargo: 715, score: 7300 });
    expect(loaded.exploration).toEqual([{ id: '30,30', bits: `03${'00'.repeat(31)}` }]);
    expect(loaded.world?.civicModules).toEqual(
      CIVIC_LOTS.map((lot) => ({ id: lot.id, builderName: 'Crew' }))
    );
    expect(loaded.sectors.get('0,0')?.[0]).toMatchObject({ id: 'mined-metal', health: 17 });
    expect(loaded.sectors.get('1,0')?.[0]).toMatchObject({
      id: 'surveyed-ice',
      material: 'ice',
      surveyedBy: ['pilot'],
    });
    expect(loaded.economy).toMatchObject({
      settlement: { level: 3, points: 440 },
      pointLoot: [{ id: 'recoverable-bank', points: 315, expiresAt: 130_000 }],
    });
    expect(() =>
      store.checkpoint(undefined, new Map(), [], undefined, {
        records: [{ kind: 'project', id: 'deep-scanner', deliveredValue: 20, completedAt: null }],
        removed: [],
      })
    ).toThrow('not activated');
  } finally {
    store.close();
  }
});

test('a changed precondition or partial migration refuses without changing legacy progress', () => {
  const { db, before } = legacyFixture();
  const digest = legacyWorldDigest(db);
  expect(() => migrateCooperativeWorld(db, 'wrong')).toThrow('changed');
  expect(readCooperativeWorld(db)).toBeUndefined();
  db.exec(
    'CREATE TABLE cooperative_schema(version INTEGER,activated INTEGER); INSERT INTO cooperative_schema VALUES(2,0);'
  );
  expect(() => migrateCooperativeWorld(db, digest)).toThrow('Incomplete');
  expect(legacyWorldDigest(db)).toBe(digest);
  expect(db.isTransaction).toBe(false);
  expect(legacyRows(db)).toEqual(before);
});

test('campaign progress and pilot credit commit atomically and invalid rows never replace them', () => {
  const { db, path } = legacyFixture();
  migrateCooperativeWorld(db, legacyWorldDigest(db));
  db.exec('UPDATE cooperative_schema SET activated=1');
  const store = new WorldStore(path, { intent: 'private' });
  try {
    const pilot = store.loadPilots()[0];
    if (!pilot) {
      throw new Error('Missing fixture pilot');
    }
    store.checkpoint(undefined, new Map(), [{ ...pilot, score: 7500 }], undefined, {
      records: [{ kind: 'project', id: 'deep-scanner', deliveredValue: 200, completedAt: null }],
      removed: [],
    });
    expect(store.load().cooperative?.records[0]).toMatchObject({ deliveredValue: 200 });
    const beforeFailure = legacyRows(db);
    const savedBeforeFailure = store.load();
    const savedEconomy = savedBeforeFailure.economy;
    if (!savedEconomy) {
      throw new Error('Fixture economy missing');
    }
    db.exec(
      "CREATE TRIGGER reject_pilot BEFORE INSERT ON pilots BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;"
    );
    expect(() =>
      store.checkpoint(
        savedBeforeFailure.world,
        new Map([['0,0', []]]),
        [{ ...pilot, score: 7900 }],
        { settlement: savedEconomy.settlement, pointLoot: [] },
        {
          records: [
            { kind: 'project', id: 'deep-scanner', deliveredValue: 600, completedAt: null },
          ],
          removed: [],
        }
      )
    ).toThrow('fixture failure');
    expect(store.load().cooperative?.records[0]).toMatchObject({ deliveredValue: 200 });
    expect(store.loadPilots()[0]?.score).toBe(7500);
    expect(legacyRows(db)).toEqual(beforeFailure);
    db.exec("UPDATE cooperative_records SET json='{}'");
    expect(() => store.load()).toThrow('Invalid cooperative record');
  } finally {
    store.close();
  }
});

test('CLI dry run is read-only, backup is exact and activation requires its current receipt', () => {
  const { path, db, before } = legacyFixture();
  const digest = legacyWorldDigest(db);
  const cli = (...args: string[]) =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/migrate-cooperative-world.ts', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  expect(JSON.parse(cli('dry-run', path)).cooperative).toBeNull();
  expect(readCooperativeWorld(db)).toBeUndefined();
  expect(legacyRows(db)).toEqual(before);
  const backupPath = join(path, '..', 'backup.sqlite');
  expect(JSON.parse(cli('apply', path, digest, backupPath))).toMatchObject({
    legacyRowsPreserved: true,
    cooperative: { activated: false },
  });
  expect(legacyRows(db)).toEqual(before);
  migrateCooperativeWorld(db, digest);
  expect(legacyRows(db)).toEqual(before);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    expect(legacyWorldDigest(backup)).toBe(digest);
    expect(legacyRows(backup)).toEqual(before);
    expect(readCooperativeWorld(backup)).toBeUndefined();
  } finally {
    backup.close();
  }
  expect(() => cli('activate', path, 'stale')).toThrow();
  expect(readCooperativeWorld(db)?.activated).toBe(false);
  expect(legacyRows(db)).toEqual(before);
  expect(JSON.parse(cli('activate', path, digest)).cooperative.activated).toBe(true);
  expect(legacyRows(db)).toEqual(before);
  expect(legacyWorldDigest(db)).toBe(digest);
});

test('CLI refuses an inspected receipt after a real persisted row changes before apply or activation', () => {
  const { path, db } = legacyFixture();
  const cli = (...args: string[]) =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/migrate-cooperative-world.ts', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  const inspected = JSON.parse(cli('inspect', path)).legacyDigest;
  db.prepare("UPDATE pilots SET json=json_set(json,'$.cargo',716) WHERE id=?").run('pilot');
  const changed = legacyRows(db);
  expect(() => cli('apply', path, inspected, join(path, '..', 'stale-backup.sqlite'))).toThrow();
  expect(readCooperativeWorld(db)).toBeUndefined();
  expect(legacyRows(db)).toEqual(changed);
  const current = JSON.parse(cli('inspect', path)).legacyDigest;
  expect(current).not.toBe(inspected);
  cli('apply', path, current, join(path, '..', 'current-backup.sqlite'));
  expect(legacyRows(db)).toEqual(changed);
  db.exec(
    "UPDATE world SET json=json_set(json,'$.exploration[0].bits','07' || substr(json_extract(json,'$.exploration[0].bits'),3)) WHERE id=1"
  );
  const changedAgain = legacyRows(db);
  expect(changedAgain.world).not.toEqual(changed.world);
  expect(() => cli('activate', path, current)).toThrow();
  expect(readCooperativeWorld(db)?.activated).toBe(false);
  expect(legacyRows(db)).toEqual(changedAgain);
  const reinspected = JSON.parse(cli('inspect', path)).legacyDigest;
  cli('activate', path, reinspected);
  expect(readCooperativeWorld(db)?.activated).toBe(true);
  expect(legacyRows(db)).toEqual(changedAgain);
});

test('worker commits campaign and pilot changes atomically and restores them after restart', async () => {
  const { path, db } = legacyFixture();
  migrateCooperativeWorld(db, legacyWorldDigest(db));
  db.exec('UPDATE cooperative_schema SET activated=1');
  const writer = new WorkerWorldPersistence(path, { intent: 'private' });
  const loaded = writer.load();
  const pilot = loaded.pilots[0];
  if (!pilot) {
    throw new Error('Pilot missing');
  }
  try {
    writer.persist({
      sectors: new Map(),
      pilots: [{ ...pilot, score: 8000 }],
      cooperative: {
        records: [{ kind: 'project', id: 'deep-scanner', deliveredValue: 800, completedAt: null }],
        removed: [],
      },
    });
    await writer.whenIdle();
  } finally {
    await writer.shutdown();
  }
  const restarted = new WorkerWorldPersistence(path, { intent: 'private' });
  try {
    const saved = restarted.load();
    expect(saved.pilots[0]?.score).toBe(8000);
    expect(saved.cooperative?.records).toEqual([
      { kind: 'project', id: 'deep-scanner', deliveredValue: 800, completedAt: null },
    ]);
  } finally {
    await restarted.shutdown();
  }
});
