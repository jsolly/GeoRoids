import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { WorldStore } from '../../../server/world/WorldStore';
import { isInsideCompletedSector } from '../../../shared/sectors';
import { sectorAt, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function deposit(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    health: 75,
    maxHealth: 75,
    jaggedness: 0.2,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

test('clearing and mapping a visited sector walls it off and relocates anyone still inside', () => {
  const engine = new GameEngine(7);
  const center = { x: 5_000, y: 1_000 };
  const miner = engine.addPlayer('miner', 'Miner', new RecordingSocket(), center);
  engine.ensureAsteroidField();
  const sector = sectorAt(center);
  expect(sector.id).toBe('2,0');

  for (const rock of engine.getAllAsteroids()) {
    if (sectorAt(rock.position).id === sector.id) {
      engine.removeAsteroid(rock.id);
    }
  }
  engine.revealArea(center, WORLD.sectorSize);
  expect(engine.evaluateSectorProgress()).toContain(sector.id);
  expect(engine.getCompletedSectors()).toContain(sector.id);
  expect(isInsideCompletedSector(miner.position, new Set(engine.getCompletedSectors()))).toBe(
    false
  );
  expect(miner.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES);
  expect(miner.lives).toBe(3);

  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }

  const late = engine.addPlayer('late', 'Late', new RecordingSocket(), center);
  expect(isInsideCompletedSector(late.position, new Set(engine.getCompletedSectors()))).toBe(false);

  const rammer = engine.addPlayer('ram', 'Ram', new RecordingSocket(), { x: 3_990, y: 1_000 });
  engine.entityManager.updateEntity(rammer.id, { spawnProtectionTimer: 0 });
  const hits = engine.resolveAuthoritativeCombat();
  expect(hits.some((hit) => hit.targetId === rammer.id && hit.attackerId === 'boundary')).toBe(
    true
  );
  expect(rammer.exploding).toBe(true);
  expect(rammer.lives).toBe(2);

  const shooter = engine.addPlayer('shooter', 'Shooter', new RecordingSocket(), {
    x: 3_950,
    y: 1_000,
  });
  const laser = engine.spawnLaser(shooter.id, { x: 3_950, y: 1_000 }, { x: 8, y: 0 });
  assert.ok(laser);
  for (let frame = 0; frame < 20; frame++) {
    engine.advanceLasersAndResolveHits();
  }
  const bounced = engine.getServerLasers().find((shot) => shot.id === laser.id);
  assert.ok(bounced);
  expect(bounced.velocity.x).toBeLessThan(0);
  expect(isInsideCompletedSector(bounced.position, new Set(engine.getCompletedSectors()))).toBe(
    false
  );
  engine.stopGameLoop();
});

test('a saved world from an older generation resets instead of loading depleted deposits', () => {
  const store = new WorldStore(':memory:');
  try {
    store.checkpoint(
      {
        seed: 1,
        startedAt: 1,
        generation: 0,
        exploration: [],
        completedSectors: [],
      },
      new Map([['0,0', [deposit('stale-ore', { x: 20, y: 20 })]]]),
      []
    );
    expect(store.loadSector('0,0')).toHaveLength(1);
    const engine = new GameEngine(99, undefined, store);
    expect(engine.getTerrainSeed()).toBe(99);
    expect(store.loadWorld()).toBeUndefined();
    expect(store.loadSector('0,0')).toBeUndefined();
    engine.stopGameLoop();
  } finally {
    store.close();
  }
});
