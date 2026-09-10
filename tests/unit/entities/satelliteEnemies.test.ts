import { afterEach, assert, beforeEach, describe, expect, test } from 'vitest';
import type { WebSocket } from 'ws';
import { GameEngine } from '../../../server/core/GameEngine';
import { EO_SATELLITE_HULL_COLOR, SATELLITE_PROFILES } from '../../../shared/eoSatellites';
import { SATELLITE } from '../../../src/constants';
import { SatelliteManager } from '../../../src/entities/satellite/SatelliteManager';
import { SHIP_KIT_IDS } from '../../../src/entities/ship/shipKits';

const DAMAGE_HALF = SATELLITE.HEALTH / 2;

function firstSatellite(engine: GameEngine) {
  const satellites = engine.createSatellites(1);
  assert.exists(satellites);
  expect(satellites.length).toBeGreaterThan(0);
  const satellite = satellites[0];
  assert.exists(satellite);
  return satellite;
}

describe('Ambient hostile EO satellites', () => {
  let gameEngine: GameEngine;

  beforeEach(() => {
    gameEngine = new GameEngine(12345);
    SatelliteManager.getInstance().clear();
  });

  afterEach(() => {
    gameEngine.stopGameLoop();
    SatelliteManager.getInstance().clear();
  });

  test('an explicit satellite seed carries the canonical EO identity and hardware hook', () => {
    const created = firstSatellite(gameEngine);
    const state = gameEngine.getGameState();

    expect(state.satellites).toHaveLength(1);
    expect(created.id).toMatch(/^server-sat-/);
    expect(created.color).toBe(EO_SATELLITE_HULL_COLOR);
    expect(created.typeId).toBe(SATELLITE_PROFILES[0]?.typeId);
    expect(created.assetKey).toBe('eo/landsat-7');
    expect(created.shotManner).toBe('steady-optical-ping');
    expect(created.health).toBe(SATELLITE.HEALTH);
    expect(gameEngine.getDiagnostics().satellites).toBe(1);
    expect(created).not.toHaveProperty('factionId');
    expect(created).not.toHaveProperty('kitId');
  });

  test('joining a live game seeds ambient NPCs without a call-in ability', () => {
    const mockWs = {} as WebSocket;
    gameEngine.addPlayer('pilot', 'Pilot', mockWs, { x: 0, y: 0 });

    expect(gameEngine.getSatelliteCount()).toBeGreaterThanOrEqual(SATELLITE.AMBIENT_COUNT);
    expect(gameEngine.getGameState().satellites.map((satellite) => satellite.typeId)).toEqual(
      SATELLITE_PROFILES.map((profile) => profile.typeId)
    );
    expect(SHIP_KIT_IDS).toHaveLength(5);
    expect(SHIP_KIT_IDS).not.toContain('hook');
  });

  test('a satellite dies when shot enough times and awards score plus loot', () => {
    const satellite = firstSatellite(gameEngine);
    const mockWs = {} as WebSocket;
    gameEngine.addPlayer('pilot', 'Pilot', mockWs, { x: 0, y: 0 });

    const wounded = gameEngine.handleSatelliteDamage(satellite.id, 'pilot', DAMAGE_HALF);
    expect(wounded).toBe(false);
    expect(gameEngine.getSatellite(satellite.id)?.health).toBe(SATELLITE.HEALTH - DAMAGE_HALF);

    const destroyed = gameEngine.handleSatelliteDamage(satellite.id, 'pilot', DAMAGE_HALF);
    expect(destroyed).toBe(true);
    expect(gameEngine.getSatellite(satellite.id)?.exploding).toBe(true);
    expect(gameEngine.getPlayer('pilot')?.score).toBe(SATELLITE.POINTS);
    expect(gameEngine.getLoot().length).toBeGreaterThan(0);
    expect(gameEngine.getLoot().every((drop) => drop.kind === 'wreckage')).toBe(true);
  });

  test('ramming a satellite on the server damages the ship and drops wreckage', () => {
    const satellite = firstSatellite(gameEngine);
    const mockWs = {} as WebSocket;
    const pilot = gameEngine.addPlayer('pilot', 'Pilot', mockWs, {
      x: satellite.position.x,
      y: satellite.position.y,
    });
    pilot.spawnProtectionTimer = 0;
    const startHealth = pilot.health;

    const results = gameEngine.resolveAuthoritativeCombat();

    expect(results.some((result) => result.attackerId === satellite.id)).toBe(true);
    expect(gameEngine.getPlayer('pilot')?.health).toBe(startHealth - SATELLITE.COLLISION_DAMAGE);
    expect(gameEngine.getSatellite(satellite.id)?.exploding).toBe(true);
    expect(gameEngine.getLoot().every((drop) => drop.kind === 'wreckage')).toBe(true);
    expect(gameEngine.getLoot().length).toBeGreaterThan(0);
  });

  test('a second killing shot does not award points again', () => {
    const satellite = firstSatellite(gameEngine);
    const mockWs = {} as WebSocket;
    gameEngine.addPlayer('pilot', 'Pilot', mockWs, { x: 0, y: 0 });
    gameEngine.handleSatelliteDamage(satellite.id, 'pilot', SATELLITE.HEALTH);
    gameEngine.handleSatelliteDamage(satellite.id, 'pilot', SATELLITE.HEALTH);
    expect(gameEngine.getPlayer('pilot')?.score).toBe(SATELLITE.POINTS);
  });

  test('satellites patrol a figure-8 and stay inside the arena', () => {
    const satellite = firstSatellite(gameEngine);
    const start = { ...satellite.position };

    for (let i = 0; i < 120; i++) {
      gameEngine.tickSatellites();
    }

    const later = gameEngine.getSatellite(satellite.id);
    assert.exists(later);
    const moved = Math.hypot(later.position.x - start.x, later.position.y - start.y);
    expect(moved).toBeGreaterThan(5);
    expect(Math.hypot(later.position.x, later.position.y)).toBeLessThan(
      SATELLITE.BOUNDARY_RADIUS + 1
    );
  });

  test('satellites shoot toward the nearest living ship regardless of faction', () => {
    const satellite = firstSatellite(gameEngine);
    const mockWs = {} as WebSocket;
    gameEngine.addPlayer(
      'near',
      'Near',
      mockWs,
      {
        x: satellite.position.x + 180,
        y: satellite.position.y,
      },
      undefined,
      'dart',
      'ion'
    );
    gameEngine.addPlayer(
      'far',
      'Far',
      mockWs,
      {
        x: satellite.position.x + 1800,
        y: satellite.position.y,
      },
      undefined,
      'warden',
      'ember'
    );

    let shots = gameEngine.drainSatelliteShots();
    for (let i = 0; i < 240 && shots.length === 0; i++) {
      shots = gameEngine.tickSatellites().filter((shot) => shot.id === satellite.id);
    }

    expect(shots.length).toBeGreaterThan(0);
    const first = shots[0];
    assert.exists(first);
    expect(Math.hypot(first.laserDirection.x, first.laserDirection.y)).toBeGreaterThan(0);
    const firingSatellite = gameEngine.getSatellite(satellite.id);
    assert.exists(firingSatellite);
    const near = gameEngine.getPlayer('near');
    assert.exists(near);
    const dx = near.position.x - firingSatellite.position.x;
    const dy = near.position.y - firingSatellite.position.y;
    const vx = first.laserDirection.x - firingSatellite.velocity.x;
    const vy = first.laserDirection.y - firingSatellite.velocity.y;
    expect((dx * vx + dy * vy) / (Math.hypot(dx, dy) * Math.hypot(vx, vy))).toBeGreaterThan(0.99);
    expect(first.shotId).toContain(first.id);
  });

  test('a complete projectile keyframe repairs an event without duplicating its shot', () => {
    const serverSatellite = firstSatellite(gameEngine);
    const clientSatellites = SatelliteManager.getInstance();
    clientSatellites.syncFromServer([serverSatellite]);

    const shotId = `${serverSatellite.id}-shot-keyframe`;
    const initialPosition = { x: 12, y: -8 };
    const initialVelocity = { x: 3, y: 1 };
    clientSatellites.addLaser(serverSatellite.id, shotId, initialPosition, initialVelocity);
    clientSatellites.addLaser(serverSatellite.id, shotId, initialPosition, initialVelocity);
    expect(clientSatellites.get(serverSatellite.id)?.lasers).toHaveLength(1);

    const keyframePosition = { x: 90, y: 40 };
    clientSatellites.syncProjectilesFromServer([
      {
        satelliteId: serverSatellite.id,
        shotId,
        position: keyframePosition,
        velocity: { x: 4, y: 2 },
        age: 6,
      },
    ]);

    const repaired = clientSatellites.get(serverSatellite.id)?.getLaserByShotId(shotId);
    expect(repaired).toBeDefined();
    expect(repaired?.position).toEqual(keyframePosition);
    expect(repaired?.velocity).toEqual({ x: 4, y: 2 });
    expect(clientSatellites.get(serverSatellite.id)?.lasers).toHaveLength(1);

    clientSatellites.syncProjectilesFromServer([]);
    expect(clientSatellites.get(serverSatellite.id)?.lasers).toHaveLength(0);
  });

  test('the authoritative projectile snapshot returns a defensive copy', () => {
    const serverSatellite = firstSatellite(gameEngine);
    const mockWs = {} as WebSocket;
    gameEngine.addPlayer('pilot', 'Pilot', mockWs, {
      x: serverSatellite.position.x + 180,
      y: serverSatellite.position.y,
    });

    let shotId: string | undefined;
    for (let frame = 0; frame < 240 && !shotId; frame += 1) {
      shotId = gameEngine.tickSatellites().find((shot) => shot.id === serverSatellite.id)?.shotId;
    }
    expect(shotId).toBeDefined();

    const snapshot = gameEngine.getActiveSatelliteProjectiles();
    const projectile = snapshot.find((row) => row.shotId === shotId);
    assert.exists(projectile);
    const originalX = projectile.position.x;
    projectile.position.x += 1000;
    expect(
      gameEngine.getActiveSatelliteProjectiles().find((row) => row.shotId === shotId)?.position.x
    ).toBe(originalX);
  });

  test('NPCs remain hostile to every soft faction', () => {
    const satellite = firstSatellite(gameEngine);
    const mockWs = {} as WebSocket;
    const ion = gameEngine.addPlayer(
      'ion',
      'Ion',
      mockWs,
      { x: 0, y: 0 },
      undefined,
      'dart',
      'ion'
    );
    const ember = gameEngine.addPlayer(
      'ember',
      'Ember',
      mockWs,
      { x: 10, y: 0 },
      undefined,
      'dart',
      'ember'
    );
    ion.spawnProtectionTimer = 0;
    ember.spawnProtectionTimer = 0;

    expect(gameEngine.handlePlayerDamage(ion.id, satellite.id, 10, 'laser')).toBe(false);
    expect(gameEngine.getPlayer(ion.id)?.health).toBeLessThan(ion.maxHealth);
    expect(gameEngine.handlePlayerDamage(ember.id, satellite.id, 10, 'laser')).toBe(false);
    expect(gameEngine.getPlayer(ember.id)?.health).toBeLessThan(ember.maxHealth);
  });

  test('a destroyed NPC leaves the snapshot until it re-enters', () => {
    const satellite = firstSatellite(gameEngine);
    const mockWs = {} as WebSocket;
    gameEngine.addPlayer('pilot', 'Pilot', mockWs, { x: 0, y: 0 });
    gameEngine.handleSatelliteDamage(satellite.id, 'pilot', SATELLITE.HEALTH);

    expect(
      gameEngine.getGameState().satellites.find((row) => row.id === satellite.id)?.exploding
    ).toBe(true);

    for (let i = 0; i < SATELLITE.EXPLODE_DURATION_FRAMES; i++) {
      gameEngine.tickSatellites();
    }

    expect(
      gameEngine.getGameState().satellites.find((row) => row.id === satellite.id)
    ).toBeUndefined();

    for (let i = 0; i < SATELLITE.RESPAWN_FRAMES; i++) {
      gameEngine.tickSatellites();
    }

    const returned = gameEngine.getGameState().satellites.find((row) => row.id === satellite.id);
    expect(returned).toBeDefined();
    expect(returned?.health).toBe(SATELLITE.HEALTH);
    expect(returned?.exploding).toBe(false);
  });

  test('resetting the world clears satellites', () => {
    firstSatellite(gameEngine);
    expect(gameEngine.getSatelliteCount()).toBeGreaterThan(0);
    gameEngine.resetForTesting();
    expect(gameEngine.getSatelliteCount()).toBe(0);
    expect(gameEngine.getGameState().satellites).toEqual([]);
  });
});
