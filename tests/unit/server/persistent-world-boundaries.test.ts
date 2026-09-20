/* @vitest-environment node */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { decodeClientCommand } from '../../../server/communication/clientCommandDecoder';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { EntityManager } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { createServerInstance } from '../../../server/createServer';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import type { PersistentPilot } from '../../../server/world/WorldStore';
import { WorldStore } from '../../../server/world/WorldStore';
import { logger } from '../../../setup/serverLogger';
import { utcScoreSeason, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

const DUPLICATE_ASTEROID_IDENTITY_PATTERN = /duplicate asteroid identity/u;
const INVALID_SAVED_ASTEROID_PATTERN = /Saved sector 0,0 asteroid 0 is invalid/u;
const DUPLICATE_SECTOR_ASTEROID_PATTERN = /appears in sectors/u;
const INVALID_SAVED_PILOT_PATTERN = /Saved pilot is invalid/u;

test('a mid-checkpoint write failure rolls back the whole world and stops further gameplay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-rollback-'));
  const path = join(directory, 'world.sqlite');
  const server = createServerInstance({ port: 0, nodeEnv: 'test', worldPath: path });
  server.gameEngine.stopGameLoop();
  server.wsCore.stopPeriodicGameStateBroadcast();
  const port = await server.listening;
  const db = new DatabaseSync(path);
  try {
    const engine = server.gameEngine;
    const socket = new RecordingSocket();
    const miner = engine.addPlayer('miner', 'Miner', socket, { x: 100, y: 100 });
    miner.asteroidInteractions = 1;
    expect(engine.registerPilot(miner, socket).ok).toBe(true);
    const target: AsteroidData = {
      ...asteroid('rollback-target', { x: 500, y: 500 }),
      material: 'rubble' as const,
      size: 50,
    };
    delete target.phenomenon;
    engine.addAsteroid(target);
    engine.checkpointWorld();
    await engine.whenPersistenceIdle();
    const read = () => ({
      world: db.prepare('SELECT * FROM world ORDER BY id').all(),
      sectors: db.prepare('SELECT * FROM sectors ORDER BY id').all(),
      pilots: db.prepare('SELECT * FROM pilots ORDER BY id').all(),
    });
    const before = read();
    // World and sector statements run first; fail the later score write.
    db.exec(
      "CREATE TRIGGER fail_score BEFORE INSERT ON pilots BEGIN SELECT RAISE(ABORT, 'injected score write failure'); END"
    );
    // The break itself succeeds in memory; the next flush carries it to the
    // worker, whose failed transaction rolls the whole batch back together.
    const errorLog = vi.spyOn(logger, 'error');
    expect(engine.applyLaserAsteroidHit(target.id, miner.id).outcome).toBe('destroyed');
    engine.checkpointWorld();
    await engine.whenPersistenceIdle();
    expect(read()).toEqual(before);
    expect(engine.isPersistenceHealthy()).toBe(false);
    // The operator gets the store's own reason once, not only the wrapper.
    const failures = errorLog.mock.calls.filter(
      ([category, event]) => category === 'WORLD' && event === 'world_persistence_failed'
    );
    expect(failures).toHaveLength(1);
    const failure = failures[0]?.[2] as { error: Error; persistence: { failed: boolean } };
    expect(failure.error.message).toContain('injected score write failure');
    expect(failure.persistence).toMatchObject({ mode: 'worker', failed: true });
    errorLog.mockRestore();
    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(health.status).toBe(503);
    expect(await health.json()).toHaveProperty('status', 'unhealthy');
    const blocked = new RecordingSocket();
    server.wsCore.getMessageHandler().handleMessage(
      {
        type: 'join',
        data: {
          id: 'blocked',
          name: 'Blocked pilot',
          position: { x: 100, y: 100 },
          snapshotVersion: 1,
          asteroidInteractions: 1,
        },
      },
      blocked
    );
    expect(blocked.received('joined')).toHaveLength(0);
    expect(blocked.received('error')).toHaveLength(1);
    expect(blocked.lastReceived('error')?.data).toBe(
      'World storage unavailable; server restarting'
    );
    expect(engine.getPlayer('blocked')).toBeUndefined();
    expect(() => engine.advanceOneFrame()).toThrow('Persistent world checkpoint failed');
    // Even if the underlying fault clears, this process cannot commit its unacknowledged state.
    db.exec('DROP TRIGGER fail_score');
    await expect(server.close()).rejects.toThrow('Persistent world checkpoint failed');
    const reopened = new WorldStore(path);
    try {
      expect(reopened.loadSector('0,0')?.some((rock) => rock.id === target.id)).toBe(true);
      expect(reopened.loadPilots().find((row) => row.id === miner.id)?.score).toBe(0);
      expect(read()).toEqual(before);
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
    try {
      if (server.gameEngine.isPersistenceHealthy()) {
        await server.close();
      } else {
        await expect(server.close()).rejects.toThrow('Persistent world checkpoint failed');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function asteroid(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    jaggedness: 0.2,
    rotation: 0,
    angularVelocity: 0,
    health: 75,
    maxHealth: 75,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'metal',
    surveyedBy: ['surveyor'],
    isCollabTarget: false,
    phenomenon: {
      kind: 'reflective',
      clusterId: id,
      energy: 0,
      maxEnergy: 6,
    },
  };
}

function scorePilot(score: number): PersistentPilot {
  return {
    id: 'pilot',
    tokenHash: 'a'.repeat(64),
    name: 'Pilot',
    score,
  };
}

function joinMessage(position: unknown): unknown {
  return {
    type: 'join',
    data: {
      id: 'pilot',
      name: 'Pilot',
      position,
      snapshotVersion: 1,
      asteroidInteractions: 1,
    },
  };
}

test('new deposits and reflective clusters stay inside their saved world sectors', () => {
  const store = new WorldStore(':memory:');
  const field = new RegionalAsteroidField(82, store.loadSectors());
  const manager = new AsteroidManager(new RNGService(82));
  try {
    const observers = Array.from({ length: 64 }, (_, index) => {
      const angle = (index / 64) * Math.PI * 2;
      return { x: Math.cos(angle) * (WORLD.radius - 50), y: Math.sin(angle) * (WORLD.radius - 50) };
    });
    field.update(manager, observers, new Set());
    expect(manager.getAllAsteroids().length).toBeGreaterThan(1000);
    expect(() =>
      store.checkpoint(
        {
          seed: 82,
          startedAt: 1,
          generation: WORLD.generation,
          exploration: [],
          completedSectors: [],
        },
        field.checkpoint(manager),
        []
      )
    ).not.toThrow();
  } finally {
    store.close();
  }
});

test('stale collection reports the engine-owned removal without deleting the entity', () => {
  let now = 0;
  const manager = new EntityManager(new RNGService(1), () => now);
  const player = manager.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });

  now = 30_001;

  expect(manager.getStalePlayerIds()).toEqual(['pilot']);
  expect(manager.getEntity('pilot')).toBe(player);
});

test('stale transport removal captures a pilot before its private token resumes it', () => {
  const engine = new GameEngine(1);
  const socket = new RecordingSocket();
  const actor = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });
  actor.asteroidInteractions = 1;
  const registered = engine.registerPilot(actor, socket);
  if (!registered.ok) {
    throw new Error(registered.error);
  }

  const now = engine.getServerTime();
  actor.lastUpdate = now - 30_001;
  engine.advanceOneFrame(now);

  expect(engine.getPlayer('pilot')).toBeUndefined();
  expect(engine.drainDepartedPlayers()).toEqual(['pilot']);
  expect(engine.isGamePaused()).toBe(true);
  const resumed = engine.resumePilot(registered.resumeToken, new RecordingSocket());
  expect(resumed.ok).toBe(true);
  if (resumed.ok) {
    expect(engine.getPlayer('pilot')).toBe(resumed.actor);
    expect(resumed.actor.score).toBe(0);
    expect(engine.isGamePaused()).toBe(false);
  }
  engine.stopGameLoop();
});

test('join decoding rejects a pilot position outside the persistent world', () => {
  for (const position of [
    { x: WORLD.radius + 1, y: 0 },
    { x: -WORLD.radius - 1, y: 0 },
    { x: '60001', y: '0' },
    { x: Number.NaN, y: 0 },
  ]) {
    expect(decodeClientCommand(joinMessage(position))).toEqual({
      ok: false,
      messageType: 'join',
      error: 'Join position is outside the world or invalid',
    });
  }
});

test('checkpoint rejects duplicate asteroid identities before writing sectors', () => {
  const store = new WorldStore(':memory:');
  try {
    const first = asteroid('duplicate', { x: 20, y: 20 });
    expect(() =>
      store.checkpoint(
        {
          seed: 1,
          startedAt: 1,
          generation: WORLD.generation,
          exploration: [],
          completedSectors: [],
        },
        new Map([['0,0', [first, { ...first }]]]),
        []
      )
    ).toThrow(DUPLICATE_ASTEROID_IDENTITY_PATTERN);
  } finally {
    store.close();
  }
});

test('checkpoint accepts deposits that cross sectors in reverse order', () => {
  const store = new WorldStore(':memory:');
  try {
    store.checkpoint(
      {
        seed: 1,
        startedAt: 1,
        generation: WORLD.generation,
        exploration: [],
        completedSectors: [],
      },
      new Map([
        ['0,0', [asteroid('first', { x: 20, y: 20 })]],
        ['1,0', [asteroid('second', { x: 2_020, y: 20 })]],
      ]),
      []
    );

    expect(() =>
      store.checkpoint(
        {
          seed: 1,
          startedAt: 1,
          generation: WORLD.generation,
          exploration: [],
          completedSectors: [],
        },
        new Map([
          ['1,0', [asteroid('first', { x: 2_020, y: 20 })]],
          ['0,0', [asteroid('second', { x: 20, y: 20 })]],
        ]),
        []
      )
    ).not.toThrow();
    expect(store.loadSector('0,0')?.map((rock) => rock.id)).toEqual(['second']);
    expect(store.loadSector('1,0')?.map((rock) => rock.id)).toEqual(['first']);
  } finally {
    store.close();
  }
});

test('checkpoint refuses a deposit already saved under a sector the batch leaves alone', () => {
  const store = new WorldStore(':memory:');
  try {
    const world = {
      seed: 1,
      startedAt: 1,
      generation: WORLD.generation,
      exploration: [],
      completedSectors: [],
    };
    store.checkpoint(world, new Map([['0,0', [asteroid('ore', { x: 20, y: 20 })]]]), []);
    // Rewriting only 1,0 with the same deposit would duplicate it across rows.
    expect(() =>
      store.checkpoint(undefined, new Map([['1,0', [asteroid('ore', { x: 2_020, y: 20 })]]]), [])
    ).toThrow(DUPLICATE_SECTOR_ASTEROID_PATTERN);
    expect(store.loadSector('1,0')).toBeUndefined();
    // Rewriting both rows moves it, and a later batch treats the move as saved.
    store.checkpoint(
      undefined,
      new Map([
        ['0,0', []],
        ['1,0', [asteroid('ore', { x: 2_020, y: 20 })]],
      ]),
      []
    );
    expect(() =>
      store.checkpoint(undefined, new Map([['0,0', [asteroid('ore', { x: 20, y: 20 })]]]), [])
    ).toThrow(DUPLICATE_SECTOR_ASTEROID_PATTERN);
    expect(store.loadSector('0,0')).toEqual([]);
    expect(store.loadSector('1,0')?.map((rock) => rock.id)).toEqual(['ore']);
  } finally {
    store.close();
  }
});

test('an inline reset that fails latches the adapter and leaves no transaction open', () => {
  const store = new WorldStore(':memory:');
  const persistence = new InlineWorldPersistence(store);
  const failures: Error[] = [];
  persistence.onFailure((error) => failures.push(error));
  try {
    const world = {
      seed: 1,
      startedAt: 1,
      generation: WORLD.generation,
      exploration: [],
      completedSectors: [],
    };
    persistence.persist({ world, sectors: new Map(), pilots: [scorePilot(5)] });
    const execOriginal = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (sql.startsWith('DELETE')) {
        throw new Error('injected reset failure');
      }
      return execOriginal.call(this, sql);
    });
    expect(() => persistence.reset()).toThrow('injected reset failure');
    vi.restoreAllMocks();
    expect(failures.map((error) => error.message)).toEqual(['injected reset failure']);
    expect(persistence.diagnostics().failed).toBe(true);
    expect(() => persistence.persist({ sectors: new Map(), pilots: [] })).toThrow(
      'injected reset failure'
    );
    // The rolled-back reset left the row and no open transaction behind.
    expect(store.loadPilots().find((pilot) => pilot.id === 'pilot')?.score).toBe(5);
    expect(() => store.checkpoint(undefined, new Map(), [scorePilot(6)])).not.toThrow();
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});

test('a commit SQLite has already rolled back reports the disk error, not a phantom rollback', () => {
  const store = new WorldStore(':memory:');
  try {
    const world = {
      seed: 1,
      startedAt: 1,
      generation: WORLD.generation,
      exploration: [],
      completedSectors: [],
    };
    const execOriginal = DatabaseSync.prototype.exec;
    // A full disk or I/O error ends the transaction inside SQLite before the
    // error is thrown, so a second ROLLBACK would fail with a different message.
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (sql === 'COMMIT') {
        execOriginal.call(this, 'ROLLBACK');
        throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' });
      }
      return execOriginal.call(this, sql);
    });
    expect(() => store.checkpoint(world, new Map(), [scorePilot(5)])).toThrow(
      'database or disk is full'
    );
    expect(() => store.reset()).toThrow('database or disk is full');
    vi.restoreAllMocks();
    // No transaction is left open once the disk recovers.
    expect(() => store.checkpoint(world, new Map(), [scorePilot(5)])).not.toThrow();
    expect(store.loadPilots().find((pilot) => pilot.id === 'pilot')?.score).toBe(5);
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});

test('a store reused after a checkpoint or reset hands the next load what is on disk', () => {
  const store = new WorldStore(':memory:');
  try {
    const world = {
      seed: 1,
      startedAt: 1,
      generation: WORLD.generation,
      exploration: [],
      completedSectors: [],
    };
    // Committed before anything was loaded: the rows parsed at open time are stale.
    store.checkpoint(world, new Map([['0,0', [asteroid('early', { x: 20, y: 20 })]]]), []);
    expect([...store.loadSectors().keys()]).toEqual(['0,0']);
    store.reset();
    expect(store.loadSectors().size).toBe(0);
    store.checkpoint(world, new Map([['1,0', [asteroid('later', { x: 2_020, y: 20 })]]]), []);
    expect([...store.loadSectors().keys()]).toEqual(['1,0']);
    // The same deposit must still be refused under another sector after the re-read.
    expect(() =>
      store.checkpoint(undefined, new Map([['0,0', [asteroid('later', { x: 20, y: 20 })]]]), [])
    ).toThrow(DUPLICATE_SECTOR_ASTEROID_PATTERN);
  } finally {
    store.close();
  }
});

test('a restart refuses invalid asteroid metadata in saved sectors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-world-validation-'));
  const path = join(directory, 'world.sqlite');
  try {
    const initial = new WorldStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    const malformed: Record<string, unknown> = { ...asteroid('malformed', { x: 20, y: 20 }) };
    malformed['surveyedBy'] = 42;
    db.prepare('INSERT INTO sectors(id,json) VALUES(?,?)').run('0,0', JSON.stringify([malformed]));
    db.close();

    expect(() => new WorldStore(path)).toThrow(INVALID_SAVED_ASTEROID_PATTERN);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restart refuses invalid mining contributor metadata in saved sectors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-world-mining-validation-'));
  const path = join(directory, 'world.sqlite');
  try {
    const initial = new WorldStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    const malformed: Record<string, unknown> = { ...asteroid('malformed', { x: 20, y: 20 }) };
    malformed['miningContributors'] = 42;
    db.prepare('INSERT INTO sectors(id,json) VALUES(?,?)').run('0,0', JSON.stringify([malformed]));
    db.close();

    expect(() => new WorldStore(path)).toThrow(INVALID_SAVED_ASTEROID_PATTERN);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restart refuses one asteroid identity stored in two sectors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-duplicate-sector-'));
  const path = join(directory, 'world.sqlite');
  try {
    const initial = new WorldStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO sectors(id,json) VALUES(?,?)').run(
      '0,0',
      JSON.stringify([asteroid('same-id', { x: 20, y: 20 })])
    );
    db.prepare('INSERT INTO sectors(id,json) VALUES(?,?)').run(
      '1,0',
      JSON.stringify([asteroid('same-id', { x: 2_020, y: 20 })])
    );
    db.close();

    expect(() => new WorldStore(path)).toThrow(DUPLICATE_SECTOR_ASTEROID_PATTERN);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restart refuses a saved pilot without a finite monthly score', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-pilot-validation-'));
  const path = join(directory, 'world.sqlite');
  try {
    const initial = new WorldStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO pilots(id,json) VALUES(?,?)').run(
      'pilot',
      JSON.stringify({ ...scorePilot(0), score: Number.NaN })
    );
    db.close();

    const store = new WorldStore(path);
    try {
      expect(() => store.loadPilots()).toThrow(INVALID_SAVED_PILOT_PATTERN);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restart loads a legacy placement record as monthly score only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-pilot-legacy-'));
  const path = join(directory, 'world.sqlite');
  try {
    const initial = new WorldStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO pilots(id,json) VALUES(?,?)').run(
      'pilot',
      JSON.stringify({
        ...scorePilot(777),
        kitId: 'surveyor',
        position: { x: WORLD.radius - 1, y: 0 },
        angle: 1.5,
        lives: 1,
        mass: 9,
        health: 1,
        maxHealth: 100,
      })
    );
    db.close();

    const store = new WorldStore(path);
    try {
      const pilots = store.loadPilots();
      expect(pilots).toEqual([scorePilot(777)]);
      store.checkpoint(
        {
          seed: 1,
          startedAt: 1,
          generation: WORLD.generation,
          scoreSeason: utcScoreSeason(1),
          exploration: [],
          completedSectors: [],
        },
        new Map(),
        pilots
      );
    } finally {
      store.close();
    }
    const rewritten = new DatabaseSync(path);
    try {
      const row = rewritten.prepare('SELECT json FROM pilots').get();
      expect(JSON.parse(String(row?.['json']))).toEqual(scorePilot(777));
    } finally {
      rewritten.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restart loads a recent flight only when lastSeenAt is present', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-pilot-flight-'));
  const path = join(directory, 'world.sqlite');
  try {
    const initial = new WorldStore(path);
    initial.close();
    const flight = {
      ...scorePilot(321),
      lastSeenAt: 1_700_000_000_000,
      kitId: 'hauler' as const,
      position: { x: 400, y: 800 },
      velocity: { x: 3, y: -1 },
      angle: 0.5,
      lives: 2,
      mass: 8,
      health: 40,
    };
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO pilots(id,json) VALUES(?,?)').run('pilot', JSON.stringify(flight));
    db.close();

    const store = new WorldStore(path);
    try {
      expect(store.loadPilots()).toEqual([flight]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a legacy saved finite burn loads as coasting cargo without losing the deposit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-legacy-boost-'));
  const path = join(directory, 'world.sqlite');
  try {
    const initial = new WorldStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    const legacy = {
      ...asteroid('legacy-cargo', { x: 20, y: 20 }),
      velocity: { x: 1, y: 2 },
      boost: { phase: 'burning', angle: 0.3, remainingFrames: 120 },
    };
    db.prepare('INSERT INTO sectors(id,json) VALUES(?,?)').run('0,0', JSON.stringify([legacy]));
    db.close();
    const restored = new WorldStore(path);
    try {
      expect(restored.loadSector('0,0')?.[0]).toEqual({ ...legacy, boost: null });
    } finally {
      restored.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
