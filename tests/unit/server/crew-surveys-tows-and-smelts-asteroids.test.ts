import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { explorationCellAt, isCellExplored } from '../../../shared/exploration';
import { FURNACES } from '../../../shared/furnaces';
import { captureSnapshot } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { RecordingSocket } from '../../support/recordingSocket';

let engine: GameEngine;
beforeEach(() => {
  engine = new GameEngine(42);
  engine.addPlayer('scout', 'Scout', new RecordingSocket(), { x: 0, y: 0 }, 'scout');
  engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 100, y: 0 }, 'hauler');
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  engine.parkSatellitePickups();
  for (const player of engine.getAllPlayers()) {
    player.spawnProtectionTimer = 0;
  }
});
afterEach(() => engine.stopGameLoop());

function deposit(id = 'ore', position = { x: 200, y: 0 }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    health: 75,
    maxHealth: 75,
    jaggedness: 0,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

function actor(id: string) {
  const value = engine.getPlayer(id);
  assert(value);
  return value;
}

test('a Scout identifies cargo and both pilots receive the full furnace reward exactly once', () => {
  const rock = deposit();
  engine.addAsteroid(rock);
  const initial = { scout: actor('scout').score, hauler: actor('hauler').score };
  expect(engine.useAbility('scout')).toBe(true);
  expect(rock.surveyedBy).toEqual(['scout']);
  expect(engine.useAbility('hauler')).toBe(true);
  expect(actor('hauler').harpoonTargetId).toBe(rock.id);
  const furnace = FURNACES[0];
  assert(furnace);
  // Arrange arrival; processFurnaceDeliveries performs consumption and scoring.
  rock.position = { ...furnace.position };
  actor('hauler').position = { x: furnace.position.x + 100, y: furnace.position.y };
  engine.processFurnaceDeliveries();
  const points = 300;
  expect(actor('hauler').score).toBe(initial.hauler + points);
  expect(actor('scout').score).toBe(initial.scout + points);
  expect(actor('hauler').harpoonTargetId).toBeNull();
  expect(engine.getAsteroid(rock.id)).toBeUndefined();
  const deliveries = engine.drainFurnaceDeliveries();
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]?.rewards.map((reward) => reward.points)).toEqual([points, points]);
  engine.processFurnaceDeliveries();
  expect(engine.drainFurnaceDeliveries()).toEqual([]);
  expect(actor('scout').score).toBe(initial.scout + points);
});

test('towing preserves attachment momentum, follows the moving Hauler, and releases on E', () => {
  const hauler = actor('hauler');
  const rock = deposit('cargo', { x: 0, y: 0 });
  engine.addAsteroid(rock);
  const original = structuredClone(rock);
  expect(engine.useAbility('hauler')).toBe(true);
  expect(rock.position).toEqual(original.position);
  expect(rock.velocity).toEqual(original.velocity);
  for (let frame = 0; frame < 400; frame++) {
    hauler.velocity = { x: 0.8, y: 0 };
    hauler.position.x += hauler.velocity.x;
    engine.tickAbilities();
    rock.position.x += rock.velocity.x;
    rock.position.y += rock.velocity.y;
  }
  expect(rock.position.x).toBeGreaterThan(200);
  expect(hauler.position.x - rock.position.x).toBeGreaterThan(60);
  expect(hauler.position.x - rock.position.x).toBeLessThan(125);
  expect(hauler.harpoonTargetId).toBe(rock.id);
  expect(engine.useAbility('hauler')).toBe(true);
  expect(hauler.harpoonTargetId).toBeNull();
  const releasedVelocity = { ...rock.velocity };
  hauler.position.x += 200;
  engine.tickAbilities();
  expect(rock.velocity).toEqual(releasedVelocity);
});

test('an owned player motion session still pulls cargo on the authoritative server', () => {
  const hauler = actor('hauler');
  const ws = hauler.ws;
  assert(ws);
  hauler.asteroidInteractions = 1;
  expect(engine.playerMotion.register(hauler, ws, 1, engine.getServerTime()).ok).toBe(true);
  const rock = deposit('cargo', { x: 0, y: 0 });
  engine.addAsteroid(rock);
  expect(engine.useAbility('hauler')).toBe(true);
  hauler.position.x += 30;
  hauler.velocity.x = 1;
  engine.tickAbilities();
  expect(rock.velocity.x).toBeGreaterThan(0);
});

test('a second Hauler cannot steal attached cargo and loose rocks do not pay at a furnace', () => {
  engine.addPlayer('other', 'Other', new RecordingSocket(), { x: 110, y: 0 }, 'hauler');
  for (const ambient of engine.getAllAsteroids()) {
    engine.removeAsteroid(ambient.id);
  }
  const rock = deposit();
  engine.addAsteroid(rock);
  expect(engine.useAbility('hauler')).toBe(true);
  expect(engine.useAbility('other')).toBe(false);
  expect(actor('other').abilityCooldownFrames).toBe(0);
  const furnace = FURNACES[0];
  assert(furnace);
  const loose = deposit('loose', { ...furnace.position });
  engine.addAsteroid(loose);
  engine.processFurnaceDeliveries();
  expect(engine.getAsteroid(loose.id)).toBe(loose);
  expect(engine.drainFurnaceDeliveries()).toEqual([]);
});

test('scans retain map discoveries after expiry without crediting distant Scouts', () => {
  const rock = deposit();
  engine.addAsteroid(rock);
  const far = deposit('far', { x: SHIP_ABILITY.SCAN_RANGE + 10, y: 0 });
  engine.addAsteroid(far);
  expect(engine.useAbility('scout')).toBe(true);
  for (let frame = 0; frame < SHIP_ABILITY.SCAN_FRAMES + 1; frame++) {
    engine.tickAbilities();
  }
  expect(actor('scout').abilityActiveFrames).toBe(0);
  expect(rock.surveyedBy).toEqual(['scout']);
  expect(far.surveyedBy).toBeUndefined();
  const cell = explorationCellAt({ x: 900, y: 0 });
  assert(cell !== null);
  expect(isCellExplored(engine.getGameState().exploration, cell)).toBe(true);
  const state = engine.getGameState();
  const snapshot = captureSnapshot({ ...state, collabTags: [], playerProjectiles: [] });
  expect(snapshot.asteroids.find((item) => item.id === rock.id)?.surveyedBy).toEqual(['scout']);
  expect(snapshot.exploration).toEqual(state.exploration);
});

test('player hulls ignore crew lasers and ship overlap while asteroid impacts still hurt', () => {
  engine.addPlayer('third', 'Third', new RecordingSocket(), { x: 200, y: 0 });
  engine.entityManager.updateEntity('third', { spawnProtectionTimer: 0 });
  const hauler = actor('hauler');
  const players = [actor('scout'), hauler, actor('third')];
  const health = players.map((player) => player.health);
  for (const shooter of players) {
    engine.spawnLaser(shooter.id, { x: -100, y: 0 }, { x: 300, y: 0 });
  }
  engine.advanceLasersAndResolveHits();
  engine.resolveAuthoritativeCombat();
  expect(players.map((player) => player.health)).toEqual(health);
  expect(engine.handleShipDamage(hauler.id, 'scout', 100).applied).toBe(false);
  expect(engine.handleShipDamage(hauler.id, 'asteroid', 25).applied).toBe(true);
  expect(hauler.health).toBe(hauler.maxHealth - 25);
});
