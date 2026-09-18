/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
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
  engine.entityManager.updateEntity(miner.id, { velocity: { x: 4, y: 0 }, angle: 0 });
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
  expect(miner.position.x).toBeGreaterThan(6_000);
  expect(miner.velocity.x).toBeGreaterThan(0);
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

test('a crew that already crossed the grid is nudged out instead of dying when the wall appears', () => {
  const engine = new GameEngine(7);
  const center = { x: 5_000, y: 1_000 };
  const miner = engine.addPlayer('miner', 'Miner', new RecordingSocket(), center);
  const partner = engine.addPlayer('partner', 'Partner', new RecordingSocket(), center);
  engine.ensureAsteroidField();
  for (const rock of engine.getAllAsteroids()) {
    if (sectorAt(rock.position).id === '2,0') {
      engine.removeAsteroid(rock.id);
    }
  }
  engine.revealArea(center, WORLD.sectorSize);
  const justAcross = {
    position: { x: 6_010, y: 1_000 },
    velocity: { x: 4, y: 0 },
    angle: 0,
    spawnProtectionTimer: 0,
  };
  engine.entityManager.updateEntity(miner.id, justAcross);
  engine.entityManager.updateEntity(partner.id, {
    ...justAcross,
    position: { x: 6_010, y: 1_020 },
  });
  expect(sectorAt(miner.position).id).toBe('3,0');
  expect(sectorAt(partner.position).id).toBe('3,0');
  expect(engine.evaluateSectorProgress()).toContain('2,0');
  for (const leaver of [miner, partner]) {
    expect(leaver.position.x).toBeGreaterThan(6_010);
    expect(leaver.velocity.x).toBeGreaterThan(0);
    expect(leaver.lives).toBe(3);
    expect(leaver.exploding).toBe(false);
  }
  engine.entityManager.updateEntity(miner.id, { spawnProtectionTimer: 0 });
  engine.entityManager.updateEntity(partner.id, { spawnProtectionTimer: 0 });
  const hits = engine.resolveAuthoritativeCombat();
  expect(hits.some((hit) => hit.targetId === miner.id || hit.targetId === partner.id)).toBe(false);
  expect(miner.exploding).toBe(false);
  expect(partner.exploding).toBe(false);
  expect(miner.lives).toBe(3);
  expect(partner.lives).toBe(3);
  engine.stopGameLoop();
});

test('enhanced movement cannot carry a ship back into a completed sector', () => {
  const engine = new GameEngine(7);
  const center = { x: 5_000, y: 1_000 };
  const socket = new RecordingSocket();
  const miner = engine.addPlayer('miner', 'Miner', socket, center);
  miner.asteroidInteractions = 1;
  engine.entityManager.updateEntity(miner.id, { velocity: { x: 4, y: 0 }, angle: 0 });
  engine.ensureAsteroidField();
  for (const rock of engine.getAllAsteroids()) {
    if (sectorAt(rock.position).id === '2,0') {
      engine.removeAsteroid(rock.id);
    }
  }
  engine.revealArea(center, WORLD.sectorSize);
  expect(engine.evaluateSectorProgress()).toContain('2,0');
  const now = engine.getServerTime();
  expect(engine.playerMotion.register(miner, socket, 1, now).ok).toBe(true);
  const outside = { ...miner.position };
  expect(
    engine.playerMotion.acceptFreePose(
      socket,
      {
        epoch: miner.playerMotion?.epoch ?? 0,
        sequence: 1,
        position: center,
        velocity: { x: 4, y: 0 },
        angle: 0,
        thrusting: true,
      },
      now + 17
    ).ok
  ).toBe(false);
  expect(miner.position).toEqual(outside);
  expect(isInsideCompletedSector(miner.position, new Set(engine.getCompletedSectors()))).toBe(
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
    const engine = new GameEngine(99, undefined, new InlineWorldPersistence(store));
    expect(engine.getTerrainSeed()).toBe(99);
    expect(store.loadWorld()).toBeUndefined();
    expect(store.loadSector('0,0')).toBeUndefined();
    engine.stopGameLoop();
  } finally {
    store.close();
  }
});
