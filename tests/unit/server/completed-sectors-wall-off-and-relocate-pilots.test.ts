/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { isFurnaceSector } from '../../../shared/furnaces';
import { isInsideCompletedSector } from '../../../shared/sectors';
import { sectorAt, utcScoreSeason, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

/** Sector 1,0 has no Works site, so mapping it still raises walls. */
const OPEN_CENTER = { x: 3_000, y: 1_000 };
const OPEN_SECTOR = '1,0';
const OPEN_WEST = 2_000;
const OPEN_EAST = 4_000;

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
  const requested = { x: OPEN_CENTER.x, y: OPEN_CENTER.y };
  const miner = engine.addPlayer('miner', 'Miner', new RecordingSocket(), requested);
  engine.entityManager.updateEntity(miner.id, { velocity: { x: 4, y: 0 }, angle: 0 });
  engine.ensureAsteroidField();
  const sector = sectorAt(OPEN_CENTER);
  expect(sector.id).toBe(OPEN_SECTOR);
  expect(isFurnaceSector(sector.id)).toBe(false);

  for (const rock of engine.getAllAsteroids()) {
    if (sectorAt(rock.position).id === sector.id) {
      engine.removeAsteroid(rock.id);
    }
  }
  engine.revealArea(OPEN_CENTER, WORLD.sectorSize);
  expect(engine.evaluateSectorProgress()).toContain(sector.id);
  expect(engine.getCompletedSectors()).toContain(sector.id);
  expect(isInsideCompletedSector(miner.position, new Set(engine.getCompletedSectors()))).toBe(
    false
  );
  expect(requested).toEqual(OPEN_CENTER);
  expect(miner.position.x).toBeGreaterThan(OPEN_EAST);
  expect(miner.velocity.x).toBeGreaterThan(0);
  expect(miner.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES);
  expect(miner.lives).toBe(3);

  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }

  const late = engine.addPlayer('late', 'Late', new RecordingSocket(), OPEN_CENTER);
  expect(isInsideCompletedSector(late.position, new Set(engine.getCompletedSectors()))).toBe(false);

  const rammer = engine.addPlayer('ram', 'Ram', new RecordingSocket(), {
    x: OPEN_WEST - 10,
    y: 1_000,
  });
  engine.entityManager.updateEntity(rammer.id, { spawnProtectionTimer: 0 });
  const hits = engine.resolveAuthoritativeCombat();
  expect(hits.some((hit) => hit.targetId === rammer.id && hit.attackerId === 'boundary')).toBe(
    true
  );
  expect(rammer.exploding).toBe(true);
  expect(rammer.lives).toBe(2);

  const shooter = engine.addPlayer('shooter', 'Shooter', new RecordingSocket(), {
    x: OPEN_WEST - 50,
    y: 1_000,
  });
  const laser = engine.spawnLaser(shooter.id, { x: OPEN_WEST - 50, y: 1_000 }, { x: 8, y: 0 });
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
  const miner = engine.addPlayer('miner', 'Miner', new RecordingSocket(), OPEN_CENTER);
  const partner = engine.addPlayer('partner', 'Partner', new RecordingSocket(), OPEN_CENTER);
  engine.ensureAsteroidField();
  for (const rock of engine.getAllAsteroids()) {
    if (sectorAt(rock.position).id === OPEN_SECTOR) {
      engine.removeAsteroid(rock.id);
    }
  }
  engine.revealArea(OPEN_CENTER, WORLD.sectorSize);
  const justAcross = {
    position: { x: OPEN_EAST + 10, y: 1_000 },
    velocity: { x: 4, y: 0 },
    angle: 0,
    spawnProtectionTimer: 0,
  };
  engine.entityManager.updateEntity(miner.id, justAcross);
  engine.entityManager.updateEntity(partner.id, {
    ...justAcross,
    position: { x: OPEN_EAST + 10, y: 1_020 },
  });
  expect(sectorAt(miner.position).id).toBe('2,0');
  expect(sectorAt(partner.position).id).toBe('2,0');
  expect(engine.evaluateSectorProgress()).toContain(OPEN_SECTOR);
  for (const leaver of [miner, partner]) {
    expect(leaver.position.x).toBeGreaterThan(OPEN_EAST + 10);
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
  const socket = new RecordingSocket();
  const miner = engine.addPlayer('miner', 'Miner', socket, OPEN_CENTER);
  miner.asteroidInteractions = 1;
  engine.entityManager.updateEntity(miner.id, { velocity: { x: 4, y: 0 }, angle: 0 });
  engine.ensureAsteroidField();
  for (const rock of engine.getAllAsteroids()) {
    if (sectorAt(rock.position).id === OPEN_SECTOR) {
      engine.removeAsteroid(rock.id);
    }
  }
  engine.revealArea(OPEN_CENTER, WORLD.sectorSize);
  expect(engine.evaluateSectorProgress()).toContain(OPEN_SECTOR);
  const now = engine.getServerTime();
  expect(engine.playerMotion.register(miner, socket, 1, now).ok).toBe(true);
  const outside = { ...miner.position };
  expect(
    engine.playerMotion.acceptFreePose(
      socket,
      {
        epoch: miner.playerMotion?.epoch ?? 0,
        sequence: 1,
        position: OPEN_CENTER,
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

test('self-guided cargo crosses a completed sector barrier while ordinary rocks stay outside', () => {
  const engine = new GameEngine(7);
  try {
    engine.addPlayer('launcher', 'Launcher', new RecordingSocket(), OPEN_CENTER, 'hauler');
    engine.ensureAsteroidField();
    for (const rock of engine.getAllAsteroids()) {
      if (sectorAt(rock.position).id === OPEN_SECTOR) {
        engine.removeAsteroid(rock.id);
      }
    }
    engine.revealArea(OPEN_CENTER, WORLD.sectorSize);
    expect(engine.evaluateSectorProgress()).toContain(OPEN_SECTOR);
    for (const rock of engine.getAllAsteroids()) {
      engine.removeAsteroid(rock.id);
    }
    const guided = deposit('guided', { x: OPEN_WEST - 1, y: 400 });
    guided.velocity = { x: 2.5, y: 0 };
    guided.boost = { phase: 'burning', ownerId: 'launcher', angle: 0 };
    const loose = deposit('loose', { x: OPEN_WEST - 1, y: 800 });
    loose.velocity = { x: 2.5, y: 0 };
    engine.addAsteroid(guided);
    engine.addAsteroid(loose);
    engine.advanceOneFrame();
    expect(guided.position.x).toBeGreaterThan(OPEN_WEST);
    expect(loose.position.x).toBeLessThan(OPEN_WEST);
  } finally {
    engine.stopGameLoop();
  }
});

test('clearing a Works sector leaves the delivery yard open instead of walling it off', () => {
  const engine = new GameEngine(7);
  try {
    const yard = { x: 5_000, y: 1_000 };
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), yard, 'hauler');
    engine.ensureAsteroidField();
    const sector = sectorAt(yard);
    expect(sector.id).toBe('2,0');
    expect(isFurnaceSector(sector.id)).toBe(true);
    for (const rock of engine.getAllAsteroids()) {
      if (sectorAt(rock.position).id === sector.id) {
        engine.removeAsteroid(rock.id);
      }
    }
    engine.revealArea(yard, WORLD.sectorSize);
    expect(engine.evaluateSectorProgress()).not.toContain(sector.id);
    expect(engine.getCompletedSectors()).not.toContain(sector.id);
    expect(isInsideCompletedSector(yard, new Set(engine.getCompletedSectors()))).toBe(false);
  } finally {
    engine.stopGameLoop();
  }
});

test('a saved completed Works sector reopens so the delivery yard stays reachable', () => {
  const store = new WorldStore(':memory:');
  const savedAt = Date.now();
  let engine: GameEngine | undefined;
  try {
    store.checkpoint(
      {
        seed: 7,
        startedAt: savedAt,
        generation: WORLD.generation,
        scoreSeason: utcScoreSeason(savedAt),
        exploration: [],
        completedSectors: ['2,0', OPEN_SECTOR],
      },
      new Map(),
      []
    );
    engine = new GameEngine(7, undefined, new InlineWorldPersistence(store));
    expect(engine.getCompletedSectors()).toContain(OPEN_SECTOR);
    expect(engine.getCompletedSectors()).not.toContain('2,0');
  } finally {
    engine?.stopGameLoop();
    store.close();
  }
});
