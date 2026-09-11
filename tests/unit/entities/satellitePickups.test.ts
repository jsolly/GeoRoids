import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GROWTH, radiusFromMass } from '../../../shared/shipGrowth';
import { SATELLITE_PICKUP } from '../../../src/constants';
import { orbitRadiusForOwner } from '../../../src/entities/satellitePickup/satellitePickupMath';
import { RecordingSocket } from '../../support/recordingSocket';

vi.mock('../../../setup/serverLogger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Satellite pickups', () => {
  let gameEngine: GameEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    gameEngine = new GameEngine(12345);
  });

  afterEach(() => {
    gameEngine.stopGameLoop();
    vi.clearAllMocks();
  });

  function addPilot(id = 'pilot', position = { x: 0, y: 0 }) {
    const pilot = gameEngine.addPlayer(id, id, new RecordingSocket(), position);
    gameEngine.updatePlayer(id, { spawnProtectionTimer: 0 });
    return pilot;
  }

  function moveNearPickup(playerId: string, pickupId: string, distance = 110): void {
    const pickup = gameEngine.getSatellitePickup(pickupId);
    assert.ok(pickup, `pickup ${pickupId}`);
    gameEngine.updatePlayer(playerId, {
      position: { x: pickup.position.x + distance, y: pickup.position.y },
    });
  }

  function collectNearest(playerId = 'pilot', distance = 110) {
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup, 'a pickup exists');
    moveNearPickup(playerId, pickup.id, distance);
    gameEngine.tickSatellitePickups();
    const collected = gameEngine.getSatellitePickup(pickup.id);
    assert.ok(collected, 'pickup remains in the roster');
    return collected;
  }

  test('pickups appear with authoritative health in the game state when a human joins', () => {
    addPilot();
    const state = gameEngine.getGameState();

    expect(state.satellitePickups).toHaveLength(2);
    expect(state.satellitePickups?.[0]?.id).toMatch(/^server-pickup-/);
    expect(state.satellitePickups?.map((pickup) => pickup.typeId)).toEqual(['echo', 'relay']);
    expect(state.satellitePickups?.map((pickup) => pickup.assetKey)).toEqual([
      'pickup/echo',
      'pickup/relay',
    ]);
    expect(state.satellitePickups?.[0]?.state).toBe('loose');
    expect(state.satellitePickups?.[0]?.health).toBe(SATELLITE_PICKUP.HEALTH);
    expect(state.satellitePickups?.[0]?.maxHealth).toBe(SATELLITE_PICKUP.HEALTH);
    expect(state.satellitePickups?.[0]?.color.toLowerCase()).toBe('#fbbf24');
    expect(state.loot).toEqual([]);
    expect(gameEngine.getDiagnostics().loot).toBe(0);
    expect(gameEngine.getDiagnostics().satellitePickups).toBe(2);
  });

  test('a reasonably close human is collected automatically and receives only the score bonus', () => {
    addPilot();
    const attached = collectNearest('pilot', 110);
    const pilot = gameEngine.getPlayer('pilot');
    assert.ok(pilot);

    expect(pilot.score).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(pilot.spawnProtectionTimer).toBe(0);
    expect(pilot.shieldActive).toBe(false);
    expect(pilot.shieldCooldown).toBe(0);
    expect(attached.state).toBe('orbiting');
    expect(attached.ownerId).toBe('pilot');
    expect(attached.health).toBe(SATELLITE_PICKUP.HEALTH);

    gameEngine.updatePlayer('pilot', { position: { x: 80, y: 40 } });
    gameEngine.tickSatellitePickups();
    const later = gameEngine.getSatellitePickup(attached.id);
    assert.ok(later);
    const dist = Math.hypot(later.position.x - 80, later.position.y - 40);
    expect(dist).toBeCloseTo(orbitRadiusForOwner(radiusFromMass(pilot.mass), later.radius), 6);
  });

  test('the nearest competing human wins once and a later tick cannot duplicate the score', () => {
    addPilot('first');
    addPilot('second');
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    moveNearPickup('first', pickup.id, 80);
    moveNearPickup('second', pickup.id, 120);

    gameEngine.tickSatellitePickups();

    expect(gameEngine.getSatellitePickup(pickup.id)?.ownerId).toBe('first');
    expect(gameEngine.getPlayer('first')?.score).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(gameEngine.getPlayer('second')?.score).toBe(0);
    gameEngine.tickSatellitePickups();
    expect(gameEngine.getPlayer('first')?.score).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(gameEngine.getPlayer('second')?.score).toBe(0);
  });

  test('a second pickup uses the current first orbit phase so the two orbiters stay apart', () => {
    addPilot();
    const [first, second] = gameEngine.getAllSatellitePickups();
    assert.ok(first);
    assert.ok(second);

    moveNearPickup('pilot', first.id);
    gameEngine.tickSatellitePickups();
    moveNearPickup('pilot', second.id);
    gameEngine.tickSatellitePickups();

    const firstAttached = gameEngine.getSatellitePickup(first.id);
    const secondAttached = gameEngine.getSatellitePickup(second.id);
    assert.ok(firstAttached);
    assert.ok(secondAttached);
    expect(firstAttached.ownerId).toBe('pilot');
    expect(secondAttached.ownerId).toBe('pilot');
    expect(Math.abs(secondAttached.position.x - firstAttached.position.x)).toBeGreaterThan(50);
    expect(Math.abs(secondAttached.position.y - firstAttached.position.y)).toBeGreaterThan(1);
  });

  test('two ordinary physical hits break a pickup and it respawns loose after the delay', () => {
    addPilot();
    const attached = collectNearest();

    expect(gameEngine.handleSatellitePickupDamage(attached.id, DAMAGE_PER_SHOT)).not.toBeNull();
    expect(gameEngine.getSatellitePickup(attached.id)?.health).toBe(
      SATELLITE_PICKUP.HEALTH - DAMAGE_PER_SHOT
    );
    expect(gameEngine.handleSatellitePickupDamage(attached.id, DAMAGE_PER_SHOT)?.state).toBe(
      'broken'
    );
    expect(gameEngine.getSatellitePickup(attached.id)?.health).toBe(0);
    expect(gameEngine.getSatellitePickup(attached.id)?.ownerId).toBeNull();

    gameEngine.updatePlayer('pilot', { position: { x: 0, y: 0 } });
    for (let frame = 0; frame < SATELLITE_PICKUP.RESPAWN_FRAMES - 1; frame += 1) {
      gameEngine.tickSatellitePickups();
    }
    expect(gameEngine.getSatellitePickup(attached.id)?.state).toBe('broken');
    gameEngine.tickSatellitePickups();

    const respawned = gameEngine.getSatellitePickup(attached.id);
    expect(respawned?.state).toBe('loose');
    expect(respawned?.ownerId).toBeNull();
    expect(respawned?.health).toBe(SATELLITE_PICKUP.HEALTH);
    expect(gameEngine.getPlayer('pilot')?.score).toBe(SATELLITE_PICKUP.SCORE_BONUS);
  });

  test('owner death releases a damaged orbiting pickup while preserving its remaining health', () => {
    addPilot();
    const attached = collectNearest();
    expect(gameEngine.handleSatellitePickupDamage(attached.id, DAMAGE_PER_SHOT)).not.toBeNull();
    const pilot = gameEngine.getPlayer('pilot');
    assert.ok(pilot);

    gameEngine.handleShipDamage('pilot', 'asteroid', pilot.health, 'collision');

    const released = gameEngine.getSatellitePickup(attached.id);
    expect(released?.state).toBe('loose');
    expect(released?.ownerId).toBeNull();
    expect(released?.health).toBe(SATELLITE_PICKUP.HEALTH - DAMAGE_PER_SHOT);
  });

  test('the orbit radius grows beyond a large owner hull', () => {
    addPilot();
    gameEngine.updatePlayer('pilot', { mass: GROWTH.SOFT_MAX_MASS });
    const pilot = gameEngine.getPlayer('pilot');
    assert.ok(pilot);
    const attached = collectNearest('pilot', 110);
    const expected = orbitRadiusForOwner(radiusFromMass(pilot.mass), attached.radius);
    const distance = Math.hypot(
      attached.position.x - pilot.position.x,
      attached.position.y - pilot.position.y
    );

    expect(expected).toBeGreaterThan(SATELLITE_PICKUP.ORBIT_RADIUS);
    expect(distance).toBeCloseTo(expected, 6);
  });

  test('distant and dead humans are never automatic collectors', () => {
    addPilot();
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    gameEngine.tickSatellitePickups();
    expect(gameEngine.getSatellitePickup(pickup.id)?.state).toBe('loose');

    gameEngine.updatePlayer('pilot', {
      position: { ...pickup.position },
      health: 0,
    });
    gameEngine.tickSatellitePickups();
    expect(gameEngine.getSatellitePickup(pickup.id)?.state).toBe('loose');
    expect(gameEngine.getPlayer('pilot')?.score).toBe(0);
  });

  test('the ordinary F-key shield remains independent after automatic collection', () => {
    addPilot();
    collectNearest();

    expect(gameEngine.requestShield('pilot', true)).toBe(true);
    const pilot = gameEngine.getPlayer('pilot');
    expect(pilot?.shieldActive).toBe(true);
    expect(pilot?.shieldTime).toBeGreaterThan(0);
    expect(pilot?.spawnProtectionTimer).toBe(0);
  });

  test('resetting the world clears pickups', () => {
    addPilot();
    expect(gameEngine.getSatellitePickupCount()).toBeGreaterThan(0);
    gameEngine.resetForTesting();
    expect(gameEngine.getSatellitePickupCount()).toBe(0);
    expect(gameEngine.getGameState().satellitePickups).toEqual([]);
  });
});

const DAMAGE_PER_SHOT = 25;
