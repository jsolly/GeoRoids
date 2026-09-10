import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { SATELLITE_PICKUP } from '../../../src/constants';
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

  test('pickups appear in the authoritative game state when a human joins', () => {
    gameEngine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    const state = gameEngine.getGameState();

    expect(state.satellitePickups).toHaveLength(2);
    expect(state.satellitePickups?.[0]?.id).toMatch(/^server-pickup-/);
    expect(state.satellitePickups?.map((pickup) => pickup.typeId)).toEqual(['echo', 'relay']);
    expect(state.satellitePickups?.map((pickup) => pickup.assetKey)).toEqual([
      'pickup/echo',
      'pickup/relay',
    ]);
    expect(state.satellitePickups?.[0]?.state).toBe('loose');
    expect(state.satellitePickups?.[0]?.color.toLowerCase()).toBe('#fbbf24');
    expect(state.loot).toEqual([]);
    expect(gameEngine.getDiagnostics().loot).toBe(0);
    expect(gameEngine.getDiagnostics().satellitePickups).toBe(2);
  });

  test('collecting a pickup awards score and a brief shield, then orbits the collector', () => {
    gameEngine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    gameEngine.updatePlayer('pilot', { position: { ...pickup.position } });

    const result = gameEngine.handleSatellitePickupCollected(pickup.id, 'pilot');
    expect(result.success).toBe(true);
    expect(gameEngine.getPlayer('pilot')?.score).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(gameEngine.getPlayer('pilot')?.spawnProtectionTimer).toBe(
      SATELLITE_PICKUP.SHIELD_FRAMES
    );
    // Pickup invuln is spawn-protection, not the #454 F-key laser bubble.
    expect(gameEngine.getPlayer('pilot')?.shieldActive).toBe(false);
    expect(gameEngine.getPlayer('pilot')?.shieldCooldown).toBe(0);

    const attached = gameEngine.getSatellitePickup(pickup.id);
    expect(attached?.state).toBe('orbiting');
    expect(attached?.ownerId).toBe('pilot');

    gameEngine.updatePlayer('pilot', { position: { x: 80, y: 40 } });
    gameEngine.tickSatellitePickups();
    const later = gameEngine.getSatellitePickup(pickup.id);
    const dist = Math.hypot((later?.position.x ?? 0) - 80, (later?.position.y ?? 0) - 40);
    expect(dist).toBeCloseTo(SATELLITE_PICKUP.ORBIT_RADIUS, 0);
  });

  test('the first collector wins and a second claim is rejected', () => {
    gameEngine.addPlayer('first', 'First', new RecordingSocket(), { x: 0, y: 0 });
    gameEngine.addPlayer('second', 'Second', new RecordingSocket(), { x: 0, y: 0 });
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    gameEngine.updatePlayer('first', { position: { ...pickup.position } });
    gameEngine.updatePlayer('second', { position: { ...pickup.position } });

    expect(gameEngine.handleSatellitePickupCollected(pickup.id, 'first').success).toBe(true);
    expect(gameEngine.handleSatellitePickupCollected(pickup.id, 'second').success).toBe(false);
    expect(gameEngine.getSatellitePickup(pickup.id)?.ownerId).toBe('first');
    expect(gameEngine.getPlayer('second')?.score).toBe(0);
  });

  test('an orbiting pickup respawns loose after the shield window', () => {
    gameEngine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    gameEngine.updatePlayer('pilot', { position: { ...pickup.position } });
    gameEngine.handleSatellitePickupCollected(pickup.id, 'pilot');

    for (let i = 0; i < SATELLITE_PICKUP.SHIELD_FRAMES; i++) {
      gameEngine.tickSatellitePickups();
    }

    const later = gameEngine.getSatellitePickup(pickup.id);
    expect(later?.state).toBe('loose');
    expect(later?.ownerId).toBeNull();
  });

  test('dying releases an orbiting pickup back to the arena', () => {
    gameEngine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    gameEngine.updatePlayer('pilot', { position: { ...pickup.position } });
    gameEngine.handleSatellitePickupCollected(pickup.id, 'pilot');
    gameEngine.updatePlayer('pilot', { spawnProtectionTimer: 0 });

    gameEngine.handlePlayerDamage('pilot', 'asteroid', 100);
    const released = gameEngine.getSatellitePickup(pickup.id);
    expect(released?.state).toBe('loose');
    expect(released?.ownerId).toBeNull();
    expect(gameEngine.getLoot().length).toBeGreaterThan(0);
    expect(gameEngine.getGameState().loot.length).toBe(gameEngine.getLoot().length);
  });

  test('F-key shield still raises after a satellite collect', () => {
    gameEngine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    gameEngine.updatePlayer('pilot', { position: { ...pickup.position } });
    expect(gameEngine.handleSatellitePickupCollected(pickup.id, 'pilot').success).toBe(true);
    expect(gameEngine.requestShield('pilot', true)).toBe(true);
    const pilot = gameEngine.getPlayer('pilot');
    expect(pilot?.shieldActive).toBe(true);
    expect(pilot?.shieldTime).toBeGreaterThan(0);
    expect(pilot?.spawnProtectionTimer).toBe(SATELLITE_PICKUP.SHIELD_FRAMES);
  });

  test('resetting the world clears pickups', () => {
    gameEngine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    expect(gameEngine.getSatellitePickupCount()).toBeGreaterThan(0);
    gameEngine.resetForTesting();
    expect(gameEngine.getSatellitePickupCount()).toBe(0);
    expect(gameEngine.getGameState().satellitePickups).toEqual([]);
  });

  test('a distant or dead ship cannot collect', () => {
    gameEngine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    expect(gameEngine.handleSatellitePickupCollected(pickup.id, 'pilot').success).toBe(false);

    gameEngine.updatePlayer('pilot', { position: { ...pickup.position }, health: 0 });
    expect(gameEngine.handleSatellitePickupCollected(pickup.id, 'pilot').success).toBe(false);
  });

  test('a claimed nearby pose cannot bypass the server-owned range check', () => {
    gameEngine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    const pickup = gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    const result = gameEngine.handleSatellitePickupCollected(pickup.id, 'pilot');
    expect(result.success).toBe(false);
    expect(gameEngine.getSatellitePickup(pickup.id)?.state).toBe('loose');
  });
});
