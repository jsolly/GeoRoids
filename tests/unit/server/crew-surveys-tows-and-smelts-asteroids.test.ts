import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { explorationCellAt, isCellExplored } from '../../../shared/exploration';
import { CIVIC_LOTS, FURNACES } from '../../../shared/furnaces';
import { SHIP_ABILITY } from '../../../shared/shipKits';
import { captureSnapshot } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';
import { resolveToolFlights } from '../../support/tool-flight';

let engine: GameEngine;
beforeEach(() => {
  engine = new GameEngine(42);
  engine.addPlayer('scout', 'Scout', new RecordingSocket(), { x: 0, y: 0 }, 'scout');
  engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 100, y: 0 }, 'hauler');
  for (const rock of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(rock.id);
  }
  engine.parkSatellitePickups();
  for (const player of engine.getAllPlayers()) {
    player.spawnProtectionTimer = 0;
  }
});
afterEach(() => {
  engine.stopGameLoop();
  vi.restoreAllMocks();
});

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

test.each(['mineral_scan', 'survey_probe'] as const)(
  '%s active frames reveal each pilot once while retaining nearby survey attribution',
  (utility) => {
    const scout = actor('scout');
    scout.position = { x: 10_000, y: 10_000 };
    scout.scoutUtility = utility;
    scout.abilityActiveFrames = 10;
    const hauler = actor('hauler');
    hauler.position = { x: 16_000, y: 10_000 };
    const near = deposit('near', { x: 10_900, y: 10_000 });
    const far = deposit('far', { x: 11_300, y: 10_000 });
    engine.asteroidLifecycle.insert(near);
    engine.asteroidLifecycle.insert(far);
    const reveal = vi.spyOn(engine.discovery, 'revealArea');

    engine.abilities.advance();

    expect(reveal.mock.calls).toEqual([
      [scout.position, 1_200],
      [hauler.position, 260],
    ]);
    expect(near.surveyedBy).toEqual([scout.id]);
    expect(far.surveyedBy).toBeUndefined();
    const cell = explorationCellAt(near.position);
    assert(cell !== null);
    expect(isCellExplored(engine.getGameState().exploration, cell)).toBe(true);
  }
);

test('a satellite widens Hauler exploration with one reveal and base Scout discovery stays intact', () => {
  const scout = actor('scout');
  const hauler = actor('hauler');
  const pickup = engine.getAllSatellitePickups()[0];
  assert(pickup);
  hauler.position = { ...pickup.position };
  engine.satelliteField.advance();
  expect(engine.equipSatellite(hauler.id, pickup.id)).toBe(true);
  scout.position = { x: 10_000, y: 10_000 };
  hauler.position = { x: 16_000, y: 10_000 };
  const near = deposit('satellite-survey', { x: 16_450, y: 10_000 });
  const far = deposit('satellite-far', { x: 16_700, y: 10_000 });
  engine.asteroidLifecycle.insert(near);
  engine.asteroidLifecycle.insert(far);
  const reveal = vi.spyOn(engine.discovery, 'revealArea');

  engine.abilities.advance();

  expect(reveal.mock.calls).toEqual([
    [scout.position, 650],
    [hauler.position, 600],
  ]);
  expect(near.surveyedBy).toEqual([hauler.id]);
  expect(far.surveyedBy).toBeUndefined();
  const cell = explorationCellAt(near.position);
  assert(cell !== null);
  expect(isCellExplored(engine.getGameState().exploration, cell)).toBe(true);
});

test('a Scout identifies cargo and both pilots receive the full furnace reward exactly once', () => {
  const rock = deposit();
  rock.ore = 'metal';
  engine.asteroidLifecycle.insert(rock);
  const initial = { scout: actor('scout').score, hauler: actor('hauler').score };
  expect(engine.useAbility('scout')).toBe(true);
  resolveToolFlights(engine);
  expect(rock.surveyedBy).toEqual(['scout']);
  const downedTow = engine.addPlayer(
    'downed-tow',
    'Downed tow',
    new RecordingSocket(),
    { x: 0, y: 0 },
    'hauler'
  );
  downedTow.health = 0;
  expect(engine.useAbility('hauler')).toBe(true);
  resolveToolFlights(engine);
  expect(actor('hauler').harpoonTargetId).toBe(rock.id);
  downedTow.harpoonTargetId = rock.id;
  downedTow.harpoonLatchPos = { ...rock.position };
  const furnace = FURNACES[0];
  const darkFoundation = CIVIC_LOTS[0];
  assert(furnace);
  assert(darkFoundation);
  rock.position = { ...darkFoundation.position };
  actor('hauler').position = {
    x: darkFoundation.position.x + 100,
    y: darkFoundation.position.y,
  };
  engine.furnaceDeliveries.advance();
  expect(engine.getAsteroid(rock.id)).toBe(rock);
  expect(actor('hauler').score).toBe(initial.hauler);
  expect(actor('scout').score).toBe(initial.scout);
  expect(engine.furnaceDeliveries.drainDeliveries()).toEqual([]);

  // Arrange arrival; FurnaceDeliveryManager.advance performs consumption and scoring.
  actor('hauler').position = { x: furnace.position.x + 100, y: furnace.position.y };
  rock.position = { x: furnace.position.x + furnace.radius + 1, y: furnace.position.y };
  engine.furnaceDeliveries.advance();
  expect(engine.getAsteroid(rock.id)).toBe(rock);
  expect(actor('hauler').score).toBe(initial.hauler);
  expect(actor('scout').score).toBe(initial.scout);
  expect(engine.furnaceDeliveries.drainDeliveries()).toEqual([]);

  rock.position.x = furnace.position.x + furnace.radius;
  engine.furnaceDeliveries.advance();
  const points = 300;
  expect(actor('hauler').score).toBe(initial.hauler + points);
  expect(actor('scout').score).toBe(initial.scout + points);
  expect(actor('hauler').harpoonTargetId).toBeNull();
  expect(downedTow.harpoonTargetId).toBeNull();
  expect(downedTow.harpoonLatchPos).toBeUndefined();
  expect(downedTow.score).toBe(0);
  expect(engine.getAsteroid(rock.id)).toBeUndefined();
  const deliveries = engine.furnaceDeliveries.drainDeliveries();
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]?.rewards.map((reward) => reward.points)).toEqual([points, points]);
  expect(deliveries[0]?.rewards.map((reward) => reward.playerId)).toEqual(['hauler', 'scout']);
  expect(deliveries[0]?.position).toEqual(furnace.position);
  expect(deliveries[0]?.position).not.toBe(furnace.position);
  expect(engine.getGameState().settlement.resources).toEqual({
    ice: 0,
    metal: 10,
    rubble: 0,
    crystal: 0,
  });
  engine.furnaceDeliveries.advance();
  expect(engine.furnaceDeliveries.drainDeliveries()).toEqual([]);
  expect(actor('scout').score).toBe(initial.scout + points);
});

test('mining a latched deposit releases its tow only on the terminal hit', () => {
  const rock = deposit('mined-tow');
  engine.asteroidLifecycle.insert(rock);
  const hauler = actor('hauler');
  expect(engine.useAbility(hauler.id)).toBe(true);
  resolveToolFlights(engine);
  expect(hauler.harpoonTargetId).toBe(rock.id);

  expect(engine.asteroidMining.hit(rock.id, hauler.id).outcome).toBe('damaged');
  expect(rock.health).toBe(25);
  expect(hauler.harpoonTargetId).toBe(rock.id);
  expect(engine.getLoot()).toEqual([]);

  expect(engine.asteroidMining.hit(rock.id, 'scout').outcome).toBe('destroyed');
  expect(engine.getAsteroid(rock.id)).toBeUndefined();
  expect(hauler.harpoonTargetId).toBeNull();
  expect(hauler.harpoonLatchPos).toBeUndefined();
  expect(engine.getLoot().filter((drop) => drop.kind === 'points')).toHaveLength(1);
  expect(engine.getLoot().filter((drop) => drop.kind === 'shard')).toHaveLength(1);
});

test('a towed burning rock pays the tow crew once instead of substituting its distinct launcher', () => {
  const rock = deposit('shared-intake');
  rock.ore = 'metal';
  engine.asteroidLifecycle.insert(rock);
  expect(engine.useAbility('hauler')).toBe(true);
  resolveToolFlights(engine);
  const hauler = actor('hauler');
  expect(hauler.harpoonTargetId).toBe(rock.id);
  const launcher = engine.addPlayer(
    'launcher',
    'Launcher',
    new RecordingSocket(),
    { x: 100, y: 100 },
    'hauler'
  );
  const furnace = FURNACES[0];
  assert(furnace);
  rock.surveyedBy = ['scout', 'hauler', 'scout'];
  hauler.position = { x: furnace.position.x + 100, y: furnace.position.y };
  engine.asteroidLifecycle.update(rock.id, {
    position: { x: furnace.position.x + furnace.radius, y: furnace.position.y },
    boost: { phase: 'burning', ownerId: launcher.id, angle: 0 },
  });

  engine.furnaceDeliveries.advance();

  expect(engine.getAsteroid(rock.id)).toBeUndefined();
  expect(hauler.harpoonTargetId).toBeNull();
  expect(hauler.score).toBe(300);
  expect(actor('scout').score).toBe(300);
  expect(launcher.score).toBe(0);
  expect(engine.getGameState().settlement.resources.metal).toBe(10);
  expect(engine.furnaceDeliveries.drainDeliveries()).toEqual([
    expect.objectContaining({
      asteroidId: rock.id,
      rewards: [
        { playerId: 'hauler', playerName: 'Hauler', points: 300 },
        { playerId: 'scout', playerName: 'Scout', points: 300 },
      ],
    }),
  ]);
  engine.furnaceDeliveries.advance();
  expect(engine.furnaceDeliveries.drainDeliveries()).toEqual([]);
  expect(hauler.score).toBe(300);
  expect(actor('scout').score).toBe(300);
  expect(launcher.score).toBe(0);
});

test('towing preserves attachment momentum, follows the moving Hauler, and releases on E', () => {
  const hauler = actor('hauler');
  const rock = deposit('cargo', { x: 0, y: 0 });
  engine.asteroidLifecycle.insert(rock);
  hauler.angle = Math.PI;
  const original = structuredClone(rock);
  expect(engine.useAbility('hauler')).toBe(true);
  resolveToolFlights(engine);
  expect(rock.position).toEqual(original.position);
  expect(rock.velocity).toEqual(original.velocity);
  for (let frame = 0; frame < 400; frame++) {
    hauler.velocity = { x: 0.8, y: 0 };
    hauler.position.x += hauler.velocity.x;
    engine.abilities.advance();
    rock.position.x += rock.velocity.x;
    rock.position.y += rock.velocity.y;
  }
  expect(rock.position.x).toBeGreaterThan(200);
  expect(hauler.position.x - rock.position.x).toBeGreaterThan(60);
  expect(hauler.position.x - rock.position.x).toBeLessThan(125);
  expect(hauler.harpoonTargetId).toBe(rock.id);
  expect(engine.useAbility('hauler')).toBe(true);
  resolveToolFlights(engine);
  expect(hauler.harpoonTargetId).toBeNull();
  const releasedVelocity = { ...rock.velocity };
  hauler.position.x += 200;
  engine.abilities.advance();
  expect(rock.velocity).toEqual(releasedVelocity);
});

test('an owned player motion session still pulls cargo on the authoritative server', () => {
  const hauler = actor('hauler');
  const ws = hauler.ws;
  assert(ws);
  expect(engine.playerMotion.register(hauler, ws, engine.getServerTime()).ok).toBe(true);
  const rock = deposit('cargo', { x: 0, y: 0 });
  engine.asteroidLifecycle.insert(rock);
  hauler.angle = Math.PI;
  expect(engine.useAbility('hauler')).toBe(true);
  resolveToolFlights(engine);
  hauler.position.x += 30;
  hauler.velocity.x = 1;
  engine.abilities.advance();
  expect(rock.velocity.x).toBeGreaterThan(0);
});

test('a second Hauler cannot steal attached cargo and loose rocks do not pay at a furnace', () => {
  engine.addPlayer('other', 'Other', new RecordingSocket(), { x: 110, y: 0 }, 'hauler');
  for (const ambient of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(ambient.id);
  }
  const rock = deposit();
  engine.asteroidLifecycle.insert(rock);
  expect(engine.useAbility('hauler')).toBe(true);
  resolveToolFlights(engine);
  expect(engine.useAbility('other')).toBe(true);
  resolveToolFlights(engine);
  expect(actor('other').harpoonTargetId).toBeNull();
  expect(actor('other').utilityFlight?.phase).toBe('reeling');
  expect(actor('other').abilityCooldownFrames).toBe(180);
  const furnace = FURNACES[0];
  assert(furnace);
  const loose = deposit('loose', { ...furnace.position });
  engine.asteroidLifecycle.insert(loose);
  engine.furnaceDeliveries.advance();
  expect(engine.getAsteroid(loose.id)).toBe(loose);
  expect(engine.furnaceDeliveries.drainDeliveries()).toEqual([]);
});

test('simultaneous tow arrivals claim cargo once and a later release makes it available again', () => {
  const other = engine.addPlayer(
    'other',
    'Other',
    new RecordingSocket(),
    { ...actor('hauler').position },
    'hauler'
  );
  for (const ambient of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(ambient.id);
  }
  const rock = deposit('contested');
  engine.asteroidLifecycle.insert(rock);
  actor('hauler').angle = 0;
  other.angle = 0;
  expect(engine.useAbility('hauler')).toBe(true);
  expect(engine.useAbility(other.id)).toBe(true);

  resolveToolFlights(engine);

  expect(actor('hauler').harpoonTargetId).toBe(rock.id);
  expect(other.harpoonTargetId).toBeNull();
  expect(other.utilityFlight?.phase).toBe('reeling');
  expect(engine.useAbility('hauler')).toBe(true);
  expect(actor('hauler').harpoonTargetId).toBeNull();
  for (let frame = 0; frame < SHIP_ABILITY.COOLDOWN_FRAMES.hauler; frame++) {
    engine.abilities.advance();
    engine.toolFlights.advance();
  }
  expect(other.utilityFlight).toBeNull();
  expect(engine.useAbility(other.id)).toBe(true);

  resolveToolFlights(engine);

  expect(other.harpoonTargetId).toBe(rock.id);
});

test('scans retain map discoveries after expiry without crediting distant Scouts', () => {
  const rock = deposit();
  engine.asteroidLifecycle.insert(rock);
  const far = deposit('far', { x: SHIP_ABILITY.SCAN_RANGE + 10, y: 0 });
  engine.asteroidLifecycle.insert(far);
  expect(engine.useAbility('scout')).toBe(true);
  resolveToolFlights(engine);
  for (let frame = 0; frame < SHIP_ABILITY.SCAN_FRAMES + 1; frame++) {
    engine.abilities.advance();
  }
  expect(actor('scout').abilityActiveFrames).toBe(0);
  expect(rock.surveyedBy).toEqual(['scout']);
  expect(far.surveyedBy).toBeUndefined();
  const cell = explorationCellAt({ x: 900, y: 0 });
  assert(cell !== null);
  expect(isCellExplored(engine.getGameState().exploration, cell)).toBe(true);
  const state = engine.getGameState();
  const snapshot = captureSnapshot({ ...state, playerProjectiles: [] });
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
  expect(engine.shipDamage.apply(hauler.id, 'scout', 100).applied).toBe(false);
  expect(engine.shipDamage.apply(hauler.id, 'asteroid', 25).applied).toBe(true);
  expect(hauler.health).toBe(hauler.maxHealth - 25);
});
