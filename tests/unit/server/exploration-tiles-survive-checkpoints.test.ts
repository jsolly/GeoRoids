/* @vitest-environment node */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import {
  explorationStorageFingerprint,
  transitionExplorationStorage,
} from '../../../server/world/explorationSchema';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorkerWorldPersistence } from '../../../server/world/WorkerWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { ExplorationMap } from '../../../shared/exploration';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
function pathForWorld(): string {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-tile-checkpoint-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'world.sqlite');
}
const metadata = { seed: 83, startedAt: 10_000, generation: WORLD.generation };
const bits = (prefix: string) => prefix.padEnd(64, '0');
function create(path: string): WorldStore {
  const store = new WorldStore(path, { intent: 'private' });
  cleanups.push(() => store.close());
  return store;
}
function inspect(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  cleanups.push(() => db.close());
  return db;
}

test('one survey cell writes one tile in a large atlas without rewriting metadata, and survives restart', () => {
  const path = pathForWorld();
  const store = create(path);
  store.checkpoint(metadata, new Map(), [], undefined, undefined, {
    kind: 'patch',
    tiles: new Map(
      Array.from({ length: 1200 }, (_, i) => [`${i % 60},${Math.floor(i / 60)}`, bits('01')])
    ),
  });
  const engine = new GameEngine(83, undefined, new InlineWorldPersistence(store));
  engine.checkpointWorld();
  const db = inspect(path);
  const before = db.prepare('SELECT json FROM world').get();
  db.exec(`CREATE TABLE tile_writes (id TEXT); CREATE TABLE world_writes (id INTEGER);
    CREATE TRIGGER count_tile_insert AFTER INSERT ON exploration BEGIN INSERT INTO tile_writes VALUES(new.id); END;
    CREATE TRIGGER count_tile_update AFTER UPDATE ON exploration BEGIN INSERT INTO tile_writes VALUES(new.id); END;
    CREATE TRIGGER count_world_update AFTER UPDATE ON world BEGIN INSERT INTO world_writes VALUES(new.id); END;`);
  const snapshot = vi.spyOn(ExplorationMap.prototype, 'snapshot');
  engine.revealArea({ x: 50_062.5, y: 62.5 }, 1);
  engine.checkpointWorld();
  expect(snapshot).not.toHaveBeenCalled();
  expect(db.prepare('SELECT * FROM tile_writes').all()).toEqual([{ id: '55,30' }]);
  expect(db.prepare('SELECT * FROM world_writes').all()).toEqual([]);
  expect(db.prepare('SELECT json FROM world').get()).toEqual(before);
  engine.checkpointWorld();
  expect(db.prepare('SELECT * FROM tile_writes').all()).toHaveLength(1);
  engine.revealArea({ x: 50_187.5, y: 62.5 }, 1);
  engine.checkpointWorld();
  expect(db.prepare('SELECT * FROM tile_writes').all()).toEqual([{ id: '55,30' }, { id: '55,30' }]);
  const restarted = new WorldStore(path);
  try {
    expect(restarted.load().exploration).toContainEqual({ id: '55,30', bits: bits('03') });
  } finally {
    restarted.close();
  }
});

test('a real worker clones tile batches before returning and durable restart reads the accepted values', async () => {
  const path = pathForWorld();
  const persistence = new WorkerWorldPersistence(path, { intent: 'private' });
  cleanups.push(() => persistence.shutdown());
  persistence.load();
  const tiles = new Map([['30,30', bits('01')]]);
  persistence.persist({
    world: metadata,
    exploration: { kind: 'patch', tiles },
    sectors: new Map(),
    pilots: [],
  });
  tiles.set('30,30', bits('07'));
  await persistence.whenIdle();
  expect(persistence.diagnostics()).toMatchObject({ failed: false, committedBatches: 1 });
  await persistence.shutdown();
  const store = new WorldStore(path);
  try {
    expect(store.load().exploration).toEqual([{ id: '30,30', bits: bits('01') }]);
  } finally {
    store.close();
  }
});

test('failed replacement rolls back tiles, opaque metadata, pilots and retained columns in one transaction', () => {
  const path = pathForWorld();
  const store = create(path);
  store.checkpoint(metadata, new Map(), [], undefined, undefined, {
    kind: 'patch',
    tiles: new Map([['30,30', bits('01')]]),
  });
  const db = inspect(path);
  db.exec(
    "CREATE TRIGGER refuse_pilot BEFORE INSERT ON pilots BEGIN SELECT RAISE(ABORT,'fixture full disk'); END;"
  );
  const before = explorationStorageFingerprint(db);
  expect(() =>
    store.checkpoint(
      { ...metadata, seed: 84 },
      new Map(),
      [{ id: 'pilot', tokenHash: 'b'.repeat(64), name: 'Pilot', score: 20 }],
      undefined,
      undefined,
      { kind: 'replace', tiles: new Map([['31,30', bits('02')]]) }
    )
  ).toThrow('fixture full disk');
  expect(explorationStorageFingerprint(db)).toBe(before);
  expect(db.isTransaction).toBe(false);
  expect(store.load().exploration).toEqual([{ id: '30,30', bits: bits('01') }]);
});

test('first engine metadata checkpoint preserves opaque numbers, retained columns and row identity', () => {
  const path = pathForWorld();
  const store = create(path);
  store.checkpoint(metadata, new Map(), []);
  const db = inspect(path);
  db.exec("ALTER TABLE world ADD COLUMN retained TEXT NOT NULL DEFAULT 'keep'");
  const opaque =
    '"opaque":{"integer":9007199254740993,"overflow":1e999,"nested":[9007199254740993]}';
  db.prepare('UPDATE world SET json=? WHERE id=1').run(
    `${JSON.stringify(metadata).slice(0, -1)},${opaque}}`
  );
  const engine = new GameEngine(83, undefined, new InlineWorldPersistence(store));
  engine.checkpointWorld();
  const saved = db.prepare('SELECT rowid AS saved_rowid,json,retained FROM world').get();
  expect(saved?.['saved_rowid']).toBe(1);
  expect(saved?.['retained']).toBe('keep');
  expect(saved?.['json']).toContain(opaque);
  expect(JSON.parse(String(saved?.['json']))).not.toHaveProperty('exploration');
});

test('diagnostic replacement clears even an empty map and explicit reset never restores old tiles', () => {
  const store = new WorldStore(':memory:');
  cleanups.push(() => store.close());
  const engine = new GameEngine(83, undefined, new InlineWorldPersistence(store));
  engine.revealArea({ x: 50_062.5, y: 62.5 }, 1);
  engine.checkpointWorld();
  engine.prepareDiagnosticWorld('traversal');
  engine.checkpointWorld();
  expect(store.load().exploration).toEqual([]);
  engine.revealArea({ x: -50_062.5, y: 62.5 }, 1);
  engine.checkpointWorld();
  expect(store.load().exploration).toEqual([{ id: '4,30', bits: bits('0080') }]);
  engine.resetForTesting();
  engine.revealArea({ x: 62.5, y: 62.5 }, 1);
  engine.checkpointWorld();
  expect(store.load().exploration).toEqual([{ id: '30,30', bits: bits('01') }]);
});

test.each(['legacy', 'prepared', 'stale-preparation'] as const)(
  'startup rejects %s before changing journal mode, schema or values',
  (state) => {
    const path = pathForWorld();
    const db = inspect(path);
    db.exec(`CREATE TABLE world (id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
    CREATE TABLE sectors (id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE pilots (id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE economy (id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);`);
    db.prepare('INSERT INTO world VALUES(1,?)').run(
      JSON.stringify({ ...metadata, exploration: [{ id: '30,30', bits: bits('01') }] })
    );
    if (state !== 'legacy') {
      transitionExplorationStorage(db, explorationStorageFingerprint(db), 'prepare');
    }
    if (state === 'stale-preparation') {
      db.prepare('UPDATE exploration SET bits=?').run(bits('03'));
    }
    const before = explorationStorageFingerprint(db);
    const journal = db.prepare('PRAGMA journal_mode').get();
    expect(() => new WorldStore(path)).toThrow(state);
    expect(explorationStorageFingerprint(db)).toBe(before);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual(journal);
  }
);

test.each([undefined, 0, 2, 1.5])(
  'an existing generation %s never resets or creates a fallback world',
  (generation) => {
    const path = pathForWorld();
    const store = create(path);
    store.checkpoint(metadata, new Map(), []);
    const db = inspect(path);
    db.prepare('UPDATE world SET json=?').run(
      JSON.stringify({ seed: 83, startedAt: 10_000, generation })
    );
    const before = explorationStorageFingerprint(db);
    expect(() => new WorldStore(path)).toThrow('generation');
    expect(() => new WorldStore(path, { intent: 'private' })).toThrow('generation');
    expect(explorationStorageFingerprint(db)).toBe(before);
  }
);

test('missing production files are not created while explicit private worlds can start fresh', () => {
  const path = pathForWorld();
  expect(() => new WorldStore(path)).toThrow();
  expect(existsSync(path)).toBe(false);
  const store = create(path);
  expect(store.load().world).toBeUndefined();
  expect(store.load().exploration).toEqual([]);
  expect(() => new WorldStore(path)).toThrow('world identity');
  store.checkpoint(metadata, new Map(), []);
  const restarted = new WorldStore(path);
  restarted.close();
});

test('active row order is canonical and malformed or orphan state is rejected without mutation', () => {
  const path = pathForWorld();
  const store = create(path);
  store.checkpoint(metadata, new Map(), [], undefined, undefined, {
    kind: 'patch',
    tiles: new Map([
      ['7,12', `${'00'.repeat(31)}80`],
      ['30,30', bits('01')],
    ]),
  });
  expect(store.load().exploration.map((tile) => tile.id)).toEqual(['30,30', '7,12']);
  const db = inspect(path);
  db.exec("UPDATE exploration SET bits='invalid'");
  const before = explorationStorageFingerprint(db);
  expect(() => new WorldStore(path)).toThrow('exploration');
  expect(explorationStorageFingerprint(db)).toBe(before);
});

test.each([
  [
    'duplicate decoded keys',
    'UPDATE world SET json=substr(json,1,length(json)-1)||\',"opaque":{"value":1,"value":2}}\'',
  ],
  ['unsupported tile columns', 'ALTER TABLE exploration ADD COLUMN retained TEXT'],
  [
    'orphan tiles',
    "INSERT INTO exploration VALUES('30,30','0100000000000000000000000000000000000000000000000000000000000000'); DELETE FROM world",
  ],
  [
    'orphan pilots',
    `INSERT INTO pilots VALUES('pilot','{"id":"pilot","name":"Pilot","tokenHash":"${'a'.repeat(64)}","score":7}'); DELETE FROM world`,
  ],
] as const)(
  'startup rejects %s under both intents without changing any data',
  (_name, mutation) => {
    const path = pathForWorld();
    const store = create(path);
    store.checkpoint(metadata, new Map(), []);
    const db = inspect(path);
    db.exec(mutation);
    const before = explorationStorageFingerprint(db);
    expect(() => new WorldStore(path)).toThrow();
    expect(() => new WorldStore(path, { intent: 'private' })).toThrow();
    expect(explorationStorageFingerprint(db)).toBe(before);
  }
);

test('the worker orders reset behind an accepted batch and keeps only the following expedition', async () => {
  const path = pathForWorld();
  const persistence = new WorkerWorldPersistence(path, { intent: 'private' });
  cleanups.push(() => persistence.shutdown());
  persistence.load();
  persistence.persist({
    world: metadata,
    exploration: { kind: 'patch', tiles: new Map([['30,30', bits('01')]]) },
    sectors: new Map(),
    pilots: [],
  });
  persistence.reset();
  persistence.persist({
    world: { ...metadata, seed: 84 },
    exploration: { kind: 'patch', tiles: new Map([['31,30', bits('02')]]) },
    sectors: new Map(),
    pilots: [],
  });
  await persistence.shutdown();
  const store = new WorldStore(path);
  try {
    expect(store.load().world?.seed).toBe(84);
    expect(store.load().exploration).toEqual([{ id: '31,30', bits: bits('02') }]);
  } finally {
    store.close();
  }
});

test('independent atlas ACKs and same-tile storage handover preserve recovery, restart and reset authority', () => {
  const path = pathForWorld();
  const store = create(path);
  store.checkpoint(metadata, new Map(), []);
  const persistence = new InlineWorldPersistence(store);
  const engine = new GameEngine(83, undefined, persistence);
  cleanups.push(() => engine.stopGameLoop());
  const broadcaster = new GameStateBroadcaster(engine);
  const left = new RecordingSocket();
  const right = new RecordingSocket();
  engine.addPlayer('atlas-left', 'Left', left, { x: 0, y: 0 });
  engine.addPlayer('atlas-right', 'Right', right, { x: 0, y: 0 });
  broadcaster.negotiateSnapshot(left);
  broadcaster.negotiateSnapshot(right);
  engine.checkpointWorld();
  const db = inspect(path);
  db.exec(`CREATE TABLE combined_tile_writes (id TEXT,operation TEXT);
    CREATE TABLE combined_world_writes (id INTEGER);
    CREATE TRIGGER combined_insert AFTER INSERT ON exploration BEGIN INSERT INTO combined_tile_writes VALUES(new.id,'insert'); END;
    CREATE TRIGGER combined_update AFTER UPDATE ON exploration BEGIN INSERT INTO combined_tile_writes VALUES(new.id,'update'); END;
    CREATE TRIGGER combined_delete AFTER DELETE ON exploration BEGIN INSERT INTO combined_tile_writes VALUES(old.id,'delete'); END;
    CREATE TRIGGER combined_world_update AFTER UPDATE ON world BEGIN INSERT INTO combined_world_writes VALUES(new.id); END;`);
  const leftDecoder = new SnapshotDecoder('live');
  const rightDecoder = new SnapshotDecoder('live');
  const apply = (socket: RecordingSocket, decoder: SnapshotDecoder, acknowledge: boolean) => {
    const raw = socket.sent.at(-1);
    assert(raw);
    const result = decoder.readMessage(raw, { acceptSnapshots: true });
    assert(result.kind === 'snapshot');
    if (acknowledge) {
      expect(broadcaster.acknowledgeSnapshot(socket, result.metadata.sequence)).toBe(true);
    }
    return result;
  };
  const tile = (rows: readonly { id: string; bits: string }[]) =>
    rows.find((row) => row.id === '55,30')?.bits;
  engine.revealArea({ x: 50_062.5, y: 62.5 }, 1);
  broadcaster.broadcastGameState();
  expect(tile(apply(left, leftDecoder, true).state.exploration)).toBe(bits('01'));
  const pendingRight = apply(right, rightDecoder, false);
  expect(tile(pendingRight.state.exploration)).toBe(bits('01'));
  expect(store.load().exploration).toEqual([]);

  let detached: ReadonlyMap<string, string> | undefined;
  const persist = persistence.persist.bind(persistence);
  vi.spyOn(persistence, 'persist').mockImplementationOnce((batch) => {
    detached = batch.exploration?.tiles;
    persist(batch);
    // A real new discovery after inline commit, before synchronous acceptance returns.
    engine.revealArea({ x: 50_187.5, y: 62.5 }, 1);
  });
  engine.checkpointWorld();
  expect(detached?.get('55,30')).toBe(bits('01'));
  expect(store.load().exploration).toEqual([{ id: '55,30', bits: bits('01') }]);
  expect(db.prepare('SELECT * FROM combined_tile_writes').all()).toEqual([
    { id: '55,30', operation: 'insert' },
  ]);
  const identity = engine.getExplorationSource().atlasIdentity();
  engine.checkpointWorld();
  expect(engine.getExplorationSource().atlasIdentity()).toEqual(identity);
  expect(detached?.get('55,30')).toBe(bits('01'));
  expect(store.load().exploration).toEqual([{ id: '55,30', bits: bits('03') }]);
  expect(db.prepare('SELECT * FROM combined_tile_writes').all()).toEqual([
    { id: '55,30', operation: 'insert' },
    { id: '55,30', operation: 'update' },
  ]);
  expect(db.prepare('SELECT * FROM combined_world_writes').all()).toEqual([]);
  expect(broadcaster.acknowledgeSnapshot(right, pendingRight.metadata.sequence)).toBe(true);
  broadcaster.requestSnapshotKeyframe(right, { recovery: true });
  broadcaster.broadcastGameState();
  expect(tile(apply(left, leftDecoder, true).state.exploration)).toBe(bits('03'));
  expect(tile(apply(right, rightDecoder, true).state.exploration)).toBe(bits('03'));
  engine.checkpointWorld();
  expect(db.prepare('SELECT * FROM combined_tile_writes').all()).toHaveLength(2);
  broadcaster.broadcastGameState();
  apply(left, leftDecoder, true);
  apply(right, rightDecoder, true);
  expect(left.sent.at(-1)).not.toContain('"atlas":');
  expect(right.sent.at(-1)).not.toContain('"atlas":');

  const restarted = new GameEngine(83, undefined, new InlineWorldPersistence(store));
  cleanups.push(() => restarted.stopGameLoop());
  expect(restarted.getExplorationSource().atlasIdentity().epoch).toBe(2);
  expect(tile(restarted.getSnapshotState().exploration)).toBe(bits('03'));
  restarted.checkpointWorld();
  expect(db.prepare('SELECT * FROM combined_tile_writes').all()).toHaveLength(2);

  const beforeResetEpoch = engine.getExplorationSource().atlasIdentity().epoch;
  engine.prepareDiagnosticWorld('combat');
  expect(engine.getExplorationSource().atlasIdentity().epoch).toBe(beforeResetEpoch + 1);
  engine.checkpointWorld();
  expect(store.load().exploration).toEqual([]);
  expect(db.prepare("SELECT * FROM combined_tile_writes WHERE operation='delete'").all()).toEqual([
    { id: '55,30', operation: 'delete' },
  ]);
  broadcaster.requestSnapshotKeyframe(left, { recovery: true });
  broadcaster.requestSnapshotKeyframe(right, { recovery: true });
  broadcaster.broadcastGameState();
  expect(apply(left, leftDecoder, true).state.exploration).toEqual([]);
  expect(apply(right, rightDecoder, true).state.exploration).toEqual([]);
  engine.revealArea({ x: -50_062.5, y: 62.5 }, 1);
  engine.checkpointWorld();
  expect(store.load().exploration).toEqual([{ id: '4,30', bits: bits('0080') }]);
  const diagnosticEpoch = engine.getExplorationSource().atlasIdentity().epoch;
  engine.resetForTesting();
  expect(engine.getExplorationSource().atlasIdentity().epoch).toBe(diagnosticEpoch + 1);
  expect(db.prepare('SELECT COUNT(*) AS count FROM exploration').get()).toEqual({ count: 0 });
});
