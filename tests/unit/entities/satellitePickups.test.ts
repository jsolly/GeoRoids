import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GROWTH } from '../../../shared/shipGrowth';
import { SATELLITE_PICKUP } from '../../../src/constants';
import { orbitRadiusForOwner } from '../../../src/entities/satellitePickup/satellitePickupMath';
import { hullRadiusForKit } from '../../../src/entities/ship/shipKits';
import { RecordingSocket } from '../../support/recordingSocket';

const SERVER_PICKUP_ID_PREFIX_PATTERN = /^server-pickup-/u;

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

  function addPilot(
    id = 'pilot',
    position = { x: 0, y: 0 },
    kitId: 'surveyor' | 'hauler' = 'surveyor'
  ) {
    const pilot = gameEngine.addPlayer(id, id, new RecordingSocket(), position, kitId);
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

  function collectNearest(playerId = 'pilot', distance = 110, equip = true) {
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup, 'a pickup exists');
    moveNearPickup(playerId, pickup.id, distance);
    gameEngine.tickSatellitePickups();
    if (equip) {
      expect(gameEngine.equipSatellite(playerId, pickup.id)).toBe(true);
    }
    const collected = gameEngine.getSatellitePickup(pickup.id);
    assert.ok(collected, 'pickup remains in the roster');
    return collected;
  }

  test('pickups appear with authoritative health in the game state when a player joins', () => {
    addPilot();
    const state = gameEngine.getGameState();

    expect(state.satellitePickups).toHaveLength(6);
    expect(state.satellitePickups?.[0]?.id).toMatch(SERVER_PICKUP_ID_PREFIX_PATTERN);
    expect(state.satellitePickups?.map((pickup) => pickup.typeId)).toEqual([
      'landsat-7',
      'terra',
      'aqua',
      'goes-16',
      'envisat',
      'worldview-3',
    ]);
    expect(state.satellitePickups?.map((pickup) => pickup.assetKey)).toEqual([
      'eo/landsat-7',
      'eo/terra',
      'eo/aqua',
      'eo/goes-16',
      'eo/envisat',
      'eo/worldview-3',
    ]);
    expect(state.satellitePickups?.[0]?.state).toBe('loose');
    expect(state.satellitePickups?.[0]?.health).toBe(SATELLITE_PICKUP.HEALTH);
    expect(state.satellitePickups?.[0]?.maxHealth).toBe(SATELLITE_PICKUP.HEALTH);
    expect(state.satellitePickups?.[0]?.color.toLowerCase()).toBe('#c4b5fd');
    expect(state.loot).toEqual([]);
    expect(gameEngine.getDiagnostics().loot).toBe(0);
    expect(gameEngine.getDiagnostics().satellitePickups).toBe(6);
  });

  test('loose hardware stays still and invulnerable without spending charge', () => {
    addPilot();
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    expect(gameEngine.handleSatellitePickupDamage(pickup.id, 1000)).toBeNull();
    for (let frame = 0; frame < 180; frame += 1) {
      gameEngine.tickSatellitePickups();
    }
    expect(gameEngine.getSatellitePickup(pickup.id)).toMatchObject({
      state: 'loose',
      position: pickup.position,
      angle: pickup.angle,
      velocity: { x: 0, y: 0 },
      health: pickup.health,
    });
  });

  test('a nearby player stores a satellite for a score bonus and equips it to orbit', () => {
    addPilot();
    const attached = collectNearest('pilot', 110);
    const pilot = gameEngine.getPlayer('pilot');
    assert.ok(pilot);

    expect(pilot.score).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(pilot.spawnProtectionTimer).toBe(0);
    expect(attached.state).toBe('orbiting');
    expect(attached.ownerId).toBe('pilot');
    expect(attached.health).toBe(SATELLITE_PICKUP.HEALTH);

    gameEngine.updatePlayer('pilot', { position: { x: 80, y: 40 } });
    gameEngine.tickSatellitePickups();
    const later = gameEngine.getSatellitePickup(attached.id);
    assert.ok(later);
    const dist = Math.hypot(later.position.x - 80, later.position.y - 40);
    expect(dist).toBeCloseTo(orbitRadiusForOwner(hullRadiusForKit(pilot.kitId), later.radius), 6);
  });

  test('the nearest competing player wins once and a later tick cannot duplicate the score', () => {
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

  test('collected hardware stays stored and only one owned satellite can be equipped', () => {
    addPilot();
    addPilot('other', { x: 4000, y: 0 });
    const [first, second] = gameEngine.getAllSatellitePickups();
    assert.ok(first);
    assert.ok(second);
    moveNearPickup('pilot', first.id);
    gameEngine.tickSatellitePickups();
    moveNearPickup('pilot', second.id);
    gameEngine.tickSatellitePickups();
    expect(gameEngine.getSatellitePickup(first.id)?.state).toBe('stored');
    expect(gameEngine.getSatellitePickup(second.id)?.state).toBe('stored');
    expect(gameEngine.handleSatellitePickupDamage(first.id, 1000)).toBeNull();
    expect(gameEngine.equipSatellite('other', first.id)).toBe(false);
    expect(gameEngine.equipSatellite('pilot', first.id)).toBe(true);
    gameEngine.tickSatellitePickups();
    expect(gameEngine.equipSatellite('pilot', first.id)).toBe(false);
    expect(gameEngine.equipSatellite('pilot', second.id)).toBe(false);
    expect(gameEngine.getSatellitePickup(first.id)?.health).toBeCloseTo(
      SATELLITE_PICKUP.HEALTH * (1 - 1 / SATELLITE_PICKUP.LIFETIME_FRAMES)
    );
    expect(gameEngine.getSatellitePickup(second.id)?.health).toBe(SATELLITE_PICKUP.HEALTH);
    gameEngine.updatePlayer('pilot', { health: 0 });
    gameEngine.tickSatellitePickups();
    expect(gameEngine.getSatellitePickup(first.id)?.state).toBe('loose');
    expect(gameEngine.getSatellitePickup(second.id)?.state).toBe('loose');
    expect(gameEngine.equipSatellite('pilot', second.id)).toBe(false);
  });

  test('a Hauler satellite identifies nearby deposits until it exhausts, without activating the core ability', () => {
    const pilot = addPilot('pilot', { x: 0, y: 0 }, 'hauler');
    const stored = collectNearest('pilot', 110, false);
    for (const asteroid of gameEngine.getAllAsteroids()) {
      gameEngine.removeAsteroid(asteroid.id);
    }
    const template = {
      velocity: { x: 0, y: 0 },
      size: 25,
      health: 75,
      maxHealth: 75,
      jaggedness: 0,
      rotation: 0,
      angularVelocity: 0,
      vertices: 4,
      offsets: [1, 1, 1, 1],
    };
    const near = {
      ...template,
      id: 'near',
      position: { x: pilot.position.x + SATELLITE_PICKUP.SCAN_RANGE, y: pilot.position.y },
    };
    const far = {
      ...template,
      id: 'far',
      position: { x: near.position.x + 1, y: pilot.position.y },
    };
    gameEngine.addAsteroid(near);
    gameEngine.addAsteroid(far);
    gameEngine.tickAbilities();
    expect(gameEngine.getAsteroid('near')?.surveyedBy).toBeUndefined();
    expect(gameEngine.equipSatellite('pilot', stored.id)).toBe(true);
    gameEngine.tickAbilities();
    expect(gameEngine.getAsteroid('near')?.surveyedBy).toEqual(['pilot']);
    expect(gameEngine.getAsteroid('far')?.surveyedBy).toBeUndefined();
    expect(pilot.abilityActiveFrames).toBe(0);
    for (let frame = 0; frame < SATELLITE_PICKUP.LIFETIME_FRAMES - 1; frame++) {
      gameEngine.tickSatellitePickups();
    }
    expect(gameEngine.getSatellitePickup(stored.id)?.state).toBe('orbiting');
    expect(gameEngine.getSatellitePickup(stored.id)?.health).toBeCloseTo(
      SATELLITE_PICKUP.HEALTH / SATELLITE_PICKUP.LIFETIME_FRAMES,
      8
    );
    gameEngine.tickSatellitePickups();
    expect(gameEngine.getSatellitePickup(stored.id)).toMatchObject({
      state: 'broken',
      ownerId: null,
      health: 0,
    });
    gameEngine.updatePlayer('pilot', {
      position: { x: pilot.position.x + 1, y: pilot.position.y },
    });
    gameEngine.tickAbilities();
    expect(gameEngine.getAsteroid('far')?.surveyedBy).toBeUndefined();
    expect(gameEngine.getAsteroid('near')?.surveyedBy).toEqual(['pilot']);
  });

  test('a half-health impact removes half the lifetime and expires at the shortened deadline', () => {
    addPilot();
    const pickup = collectNearest();
    gameEngine.handleSatellitePickupDamage(pickup.id, SATELLITE_PICKUP.HEALTH / 2);
    expect(gameEngine.getSatellitePickup(pickup.id)?.health).toBe(SATELLITE_PICKUP.HEALTH / 2);
    for (let frame = 0; frame < SATELLITE_PICKUP.LIFETIME_FRAMES / 2 - 1; frame++) {
      gameEngine.tickSatellitePickups();
    }
    expect(gameEngine.getSatellitePickup(pickup.id)?.state).toBe('orbiting');
    expect(gameEngine.getSatellitePickup(pickup.id)?.health).toBeCloseTo(
      SATELLITE_PICKUP.HEALTH / SATELLITE_PICKUP.LIFETIME_FRAMES,
      8
    );
    gameEngine.tickSatellitePickups();
    expect(gameEngine.getSatellitePickup(pickup.id)).toMatchObject({ state: 'broken', health: 0 });
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

    gameEngine.handleShipDamage('pilot', 'asteroid', pilot.health);

    const released = gameEngine.getSatellitePickup(attached.id);
    expect(released?.state).toBe('loose');
    expect(released?.ownerId).toBeNull();
    expect(released?.health).toBe(SATELLITE_PICKUP.HEALTH - DAMAGE_PER_SHOT);
    expect(gameEngine.handleSatellitePickupDamage(attached.id, 1000)).toBeNull();
    for (let frame = 0; frame < 60; frame += 1) {
      gameEngine.tickSatellitePickups();
    }
    expect(gameEngine.getSatellitePickup(attached.id)).toEqual(released);
  });

  test('Surveyor mass does not expand a satellite orbit beyond the kit hull', () => {
    addPilot();
    gameEngine.updatePlayer('pilot', { mass: GROWTH.SOFT_MAX_MASS });
    const pilot = gameEngine.getPlayer('pilot');
    assert.ok(pilot);
    const attached = collectNearest('pilot', 110);
    const expected = orbitRadiusForOwner(hullRadiusForKit(pilot.kitId), attached.radius);
    const distance = Math.hypot(
      attached.position.x - pilot.position.x,
      attached.position.y - pilot.position.y
    );

    expect(expected).toBe(SATELLITE_PICKUP.ORBIT_RADIUS);
    expect(distance).toBeCloseTo(expected, 6);
    expect(pilot.mass).toBe(GROWTH.SOFT_MAX_MASS);
  });

  test('a Hauler satellite orbits farther than a same-mass Surveyor and clears the barge hull', () => {
    addPilot('scout', { x: 0, y: 0 }, 'surveyor');
    addPilot('barge', { x: 4000, y: 0 }, 'hauler');
    const [scoutPickup, bargePickup] = gameEngine.getAllSatellitePickups();
    assert.ok(scoutPickup);
    assert.ok(bargePickup);
    moveNearPickup('scout', scoutPickup.id, 110);
    moveNearPickup('barge', bargePickup.id, 110);
    gameEngine.tickSatellitePickups();

    expect(gameEngine.equipSatellite('scout', scoutPickup.id)).toBe(true);
    expect(gameEngine.equipSatellite('barge', bargePickup.id)).toBe(true);
    const scout = gameEngine.getPlayer('scout');
    const barge = gameEngine.getPlayer('barge');
    const scoutSat = gameEngine.getSatellitePickup(scoutPickup.id);
    const bargeSat = gameEngine.getSatellitePickup(bargePickup.id);
    assert.ok(scout);
    assert.ok(barge);
    assert.ok(scoutSat);
    assert.ok(bargeSat);
    expect(scoutSat.ownerId).toBe('scout');
    expect(bargeSat.ownerId).toBe('barge');

    const scoutDist = Math.hypot(
      scoutSat.position.x - scout.position.x,
      scoutSat.position.y - scout.position.y
    );
    const bargeDist = Math.hypot(
      bargeSat.position.x - barge.position.x,
      bargeSat.position.y - barge.position.y
    );
    const bargeClearance = hullRadiusForKit('hauler') + bargeSat.radius;
    expect(scoutDist).toBeCloseTo(SATELLITE_PICKUP.ORBIT_RADIUS, 6);
    expect(bargeDist).toBeGreaterThan(scoutDist);
    expect(bargeDist).toBeGreaterThanOrEqual(bargeClearance + SATELLITE_PICKUP.ORBIT_GAP - 1e-6);
    expect(bargeDist).toBeCloseTo(
      orbitRadiusForOwner(hullRadiusForKit('hauler'), bargeSat.radius),
      6
    );
  });

  test('distant and dead players are never automatic collectors', () => {
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

  test('resetting the world clears pickups', () => {
    addPilot();
    expect(gameEngine.getSatellitePickupCount()).toBeGreaterThan(0);
    gameEngine.resetForTesting();
    expect(gameEngine.getSatellitePickupCount()).toBe(0);
    expect(gameEngine.getGameState().satellitePickups).toEqual([]);
  });
});

const DAMAGE_PER_SHOT = 25;
