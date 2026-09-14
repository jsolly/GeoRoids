/* @vitest-environment node */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { decodeClientCommand } from '../../../server/communication/clientCommandDecoder';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { EntityManager } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { createServerInstance } from '../../../server/createServer';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import type { PersistentPilot } from '../../../server/world/WorldStore';
import { WorldStore } from '../../../server/world/WorldStore';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

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
    expect(() => engine.applyLaserAsteroidHit(target.id, miner.id)).toThrow(
      'Persistent world checkpoint failed'
    );
    expect(read()).toEqual(before);
    expect(engine.isPersistenceHealthy()).toBe(false);
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

function pilot(position: { x: number; y: number }): PersistentPilot {
  return {
    id: 'pilot',
    tokenHash: 'a'.repeat(64),
    name: 'Pilot',
    kitId: 'surveyor',
    position,
    angle: 0,
    score: 0,
    lives: 3,
    mass: 1,
    health: 100,
    maxHealth: 100,
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
  const field = new RegionalAsteroidField(82, store);
  const manager = new AsteroidManager(new RNGService(82));
  try {
    const observers = Array.from({ length: 64 }, (_, index) => {
      const angle = (index / 64) * Math.PI * 2;
      return { x: Math.cos(angle) * (WORLD.radius - 50), y: Math.sin(angle) * (WORLD.radius - 50) };
    });
    field.update(manager, observers);
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
  const player = manager.addHumanPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });

  now = 30_001;

  expect(manager.getStaleHumanIds()).toEqual(['pilot']);
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
    ).toThrow(/duplicate asteroid identity/);
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

    expect(() => new WorldStore(path)).toThrow(/Saved sector 0,0 asteroid 0 is invalid/);
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

    expect(() => new WorldStore(path)).toThrow(/Saved sector 0,0 asteroid 0 is invalid/);
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

    expect(() => new WorldStore(path)).toThrow(/appears in sectors/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restart refuses a saved pilot outside the persistent world', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-pilot-validation-'));
  const path = join(directory, 'world.sqlite');
  try {
    const initial = new WorldStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO pilots(id,json) VALUES(?,?)').run(
      'pilot',
      JSON.stringify(pilot({ x: WORLD.radius + 1, y: 0 }))
    );
    db.close();

    const store = new WorldStore(path);
    try {
      expect(() => store.loadPilots()).toThrow(/Saved pilot is invalid/);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
