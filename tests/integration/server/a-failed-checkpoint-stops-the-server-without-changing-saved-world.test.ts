/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { createServerInstance } from '../../../server/createServer';
import { WorldStore } from '../../../server/world/WorldStore';
import { logger } from '../../../setup/serverLogger';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

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
    surveyedBy: ['scout'],
    phenomenon: {
      kind: 'reflective',
      clusterId: id,
      energy: 0,
      maxEnergy: 6,
    },
  };
}

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
    const healthBody = await health.json();
    expect(healthBody).toMatchObject({
      status: 'unhealthy',
      world: { players: 1, persistence: { failed: true } },
    });
    expect(healthBody).not.toHaveProperty('players');
    // The operator status JSON reports the same outage instead of a fixed healthy answer.
    const status = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    expect(status.status).toBe(503);
    expect(await status.json()).toMatchObject({
      server: { status: 'unhealthy' },
      websockets: { game: { status: 'unavailable' }, logs: { status: 'available' } },
    });
    const blocked = new RecordingSocket();
    server.wsCore.getMessageHandler().handleMessage(
      {
        type: 'join',
        data: {
          id: 'blocked',
          name: 'Blocked pilot',
          position: { x: 100, y: 100 },
          snapshotVersion: SNAPSHOT_VERSION,
          asteroidInteractions: 1,
          explorationVersion: 1,
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
