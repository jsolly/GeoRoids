/* @vitest-environment node */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import type { CombatBroadcast } from '../../../server/core/types';
import { DAMAGE } from '../../../shared/constants/gameplay';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { asteroidRow } from '../../support/asteroid-row';
import { RecordingSocket } from '../../support/recordingSocket';

function addRubble(engine: GameEngine): AsteroidData {
  const rubble: AsteroidData = {
    id: 'rubble-ram-target',
    material: 'rubble',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 50,
    jaggedness: 0.7,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
  engine.asteroidLifecycle.insert(rubble);
  return rubble;
}

describe('server authority boundaries', () => {
  let engine: GameEngine | undefined;

  afterEach(() => {
    engine?.stopGameLoop();
    engine = undefined;
  });

  test('an ability request cannot switch the kit selected at join', () => {
    engine = new GameEngine(42);
    const core = new WebSocketCore(engine);
    const ws = new RecordingSocket();
    core.handleClientMessage(
      {
        type: 'join',
        data: {
          id: 'pilot',
          name: 'Pilot',
          kitId: 'scout',
          position: { x: 0, y: 0 },
          snapshotVersion: SNAPSHOT_VERSION,
          asteroidInteractions: 1,
          explorationVersion: 1,
        },
      },
      ws
    );

    const pilot = engine.getPlayer('pilot');
    assert.ok(pilot, 'ability pilot');
    const maxHealth = pilot.maxHealth;

    core.handleClientMessage(
      {
        type: 'useAbility',
        id: 'pilot',
        data: { kitId: 'hauler' },
      },
      ws
    );

    // The request's kit is ignored: stats stay Scout and the Scout tool runs.
    expect(pilot.kitId).toBe('scout');
    expect(pilot.maxHealth).toBe(maxHealth);
    expect(pilot.abilityCooldownFrames).toBeGreaterThan(0);
    expect(pilot.harpoonTargetId ?? null).toBeNull();
  });

  test('a rammed rubble rock breaks without fragments', () => {
    engine = new GameEngine(43);
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    delete pilot.spawnProtectionTimer;
    for (const asteroid of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(asteroid.id);
    }
    const rubble = addRubble(engine);

    const results = engine.contactCombat.advance();
    const result = results.find((entry) => entry.destroyedAsteroidId === rubble.id);
    assert.ok(result, 'rubble collision result');

    expect(result.newAsteroids).toEqual([]);
    expect(result.origin).toEqual({ x: 0, y: 0 });
  });
});

function twoPilotsRamSeparateRocks(engine: GameEngine) {
  const first = engine.addPlayer('first', 'First', new RecordingSocket(), { x: 1000, y: 1000 });
  const second = engine.addPlayer('second', 'Second', new RecordingSocket(), { x: 1400, y: 1000 });
  first.spawnProtectionTimer = 0;
  second.spawnProtectionTimer = 0;
  first.health = 83;
  second.health = 97;
  for (const rock of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(rock.id);
  }
  engine.parkSatellitePickups();
  engine.asteroidLifecycle.insert({
    ...asteroidRow({ ...first.position }, 25, 'first-rock'),
    health: 40,
    maxHealth: 40,
  });
  engine.asteroidLifecycle.insert({
    ...asteroidRow({ ...second.position }, 25, 'second-rock'),
    health: 40,
    maxHealth: 40,
  });
  const firstRock = engine.getAsteroid('first-rock');
  assert.ok(firstRock);
  return { first, second, firstRock, firstHealth: first.health, secondHealth: second.health };
}

describe('contact result delivery', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('boundary death precedes the ram result and both consequences are ready before delivery', () => {
    const { first, second, secondHealth } = twoPilotsRamSeparateRocks(engine);
    first.position = { x: WORLD.radius + 10, y: 0 };
    const deliveries: CombatBroadcast[] = [];
    engine.contactCombat.setSink((result) => {
      expect(first.health).toBe(0);
      expect(first.exploding).toBe(true);
      expect(second.health).toBe(secondHealth - DAMAGE.ASTEROID_COLLISION);
      expect(engine.getAsteroid('second-rock')).toBeUndefined();
      deliveries.push(result);
    });

    const results = engine.contactCombat.advance();

    expect(results.map((result) => [result.targetId, result.attackerId])).toEqual([
      [first.id, 'boundary'],
      [second.id, 'asteroid'],
    ]);
    expect(results[0]).toMatchObject({ remainingHealth: 0, isDestroyed: true });
    expect(results[1]).toMatchObject({ remainingHealth: second.health, isDestroyed: false });
    expect(deliveries[0]).toBe(results[0]);
    expect(deliveries[1]).toBe(results[1]);
  });

  test('all ram consequences precede delivery and a replacement sink receives the next actual result', () => {
    const { first, second, firstRock, firstHealth, secondHealth } =
      twoPilotsRamSeparateRocks(engine);
    const deliveries: Array<{ sink: string; result: CombatBroadcast }> = [];
    engine.contactCombat.setSink((result) => {
      expect(first.health).toBe(firstHealth - DAMAGE.ASTEROID_COLLISION);
      expect(second.health).toBe(secondHealth - DAMAGE.ASTEROID_COLLISION);
      expect(engine.getAsteroid('first-rock')).toBeUndefined();
      expect(engine.getAsteroid('second-rock')).toBeUndefined();
      deliveries.push({ sink: 'first', result });
      engine.contactCombat.setSink((next) =>
        deliveries.push({ sink: 'replacement', result: next })
      );
    });

    const results = engine.contactCombat.advance();

    expect(results.map((result) => result.targetId)).toEqual(['first', 'second']);
    expect(results[0]).toMatchObject({
      targetId: first.id,
      attackerId: 'asteroid',
      damage: DAMAGE.ASTEROID_COLLISION,
      remainingHealth: first.health,
      isDestroyed: false,
      targetType: 'player',
      destroyedAsteroidId: 'first-rock',
      newAsteroids: [],
    });
    expect(deliveries.map((row) => row.sink)).toEqual(['first', 'replacement']);
    expect(deliveries[0]?.result).toBe(results[0]);
    expect(deliveries[1]?.result).toBe(results[1]);
    expect(results[0]?.origin).toBe(firstRock.position);
  });

  test('clearing the sink stops later delivery after both actual rams have already applied', () => {
    const { first, second, firstHealth, secondHealth } = twoPilotsRamSeparateRocks(engine);
    const deliveries: CombatBroadcast[] = [];
    engine.contactCombat.setSink((result) => {
      deliveries.push(result);
      engine.contactCombat.setSink(null);
    });

    const results = engine.contactCombat.advance();

    expect(results.map((result) => result.targetId)).toEqual(['first', 'second']);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe(results[0]);
    expect(first.health).toBe(firstHealth - DAMAGE.ASTEROID_COLLISION);
    expect(second.health).toBe(secondHealth - DAMAGE.ASTEROID_COLLISION);
    expect(engine.getAsteroid('first-rock')).toBeUndefined();
    expect(engine.getAsteroid('second-rock')).toBeUndefined();
  });

  test('a throwing sink stops delivery while retaining both completed ram consequences', () => {
    const { first, second, firstHealth, secondHealth } = twoPilotsRamSeparateRocks(engine);
    const failure = new Error('combat delivery failed');
    const deliveries: CombatBroadcast[] = [];
    engine.contactCombat.setSink((result) => {
      deliveries.push(result);
      throw failure;
    });

    assert.throws(
      () => engine.contactCombat.advance(),
      (error) => error === failure
    );

    expect(deliveries.map((result) => result.targetId)).toEqual(['first']);
    expect(first.health).toBe(firstHealth - DAMAGE.ASTEROID_COLLISION);
    expect(second.health).toBe(secondHealth - DAMAGE.ASTEROID_COLLISION);
    expect(engine.getAsteroid('first-rock')).toBeUndefined();
    expect(engine.getAsteroid('second-rock')).toBeUndefined();
  });
});
