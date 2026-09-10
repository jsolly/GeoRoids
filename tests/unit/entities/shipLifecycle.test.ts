import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isStaleDeathPose } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHIP } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  applySharedShipRespawnCue,
  applyShipBoundaryDeath,
  applyShipLethalCollision,
  applyShipSpawnProtection,
  applyShipSpawnProtectionForRemainingFrames,
  clearShipSpawnProtection,
  isServerRespawnActive,
  isShipCollisionImmune,
  isSilentHudReset,
  shouldApplyDamagedHealth,
  shouldDrawShipHull,
} from '../../../src/entities/ship/shipUtils';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { RecordingSocket } from '../../support/recordingSocket';
import { SHIP_KINDS } from '../scenarios/support/shipKinds';

describe('client explode ticks follow the 60 Hz clock', () => {
  test.each(SHIP_KINDS)('$kind hitch-drains explodeTime without dropping the exploding flag', ({
    options,
  }) => {
    const ship = new Ship(options);
    ship.takeDamage(100);
    expect(ship.exploding).toBe(true);
    expect(ship.explodeTime).toBe(SHIP.EXPLODE_DURATION_FRAMES);
    ship.updateLifecycle(SHIP.EXPLODE_DURATION_FRAMES);
    expect(ship.explodeTime).toBe(0);
    expect(ship.exploding).toBe(true);
  });

  test('a sub-frame update does not burn explode frames', () => {
    const ship = new Ship({ isLocalPlayer: true });
    ship.takeDamage(100);
    ship.updateLifecycle(0);
    expect(ship.exploding).toBe(true);
    expect(ship.explodeTime).toBe(SHIP.EXPLODE_DURATION_FRAMES);
  });

  test('a late exploding snapshot does not rewind a finished death FX', () => {
    const player = new Player({
      id: 'local',
      name: 'Local',
      type: 'local',
      input: new MockPlayerInput(),
    });
    player.ship.takeDamage(100, 'boundary');
    player.ship.updateLifecycle(SHIP.EXPLODE_DURATION_FRAMES);
    expect(player.ship.explodeTime).toBe(0);

    player.updateFromServer({ exploding: true, health: 0 });

    expect(player.ship.explodeTime).toBe(0);
    expect(player.ship.exploding).toBe(true);
    expect(player.ship.health).toBe(0);
  });

  test('a dead hull does not drift while waiting for server respawn', () => {
    const ship = new Ship({ isLocalPlayer: true });
    ship.position = { x: 10, y: 20 };
    ship.velocity = { x: 4, y: 0 };
    ship.health = 0;
    ship.exploding = false;
    ship.update();
    expect(ship.position).toEqual({ x: 10, y: 20 });
  });
});

describe('shared ship HUD and respawn timers', () => {
  test('respawnTimer 0 is not an active countdown', () => {
    expect(isServerRespawnActive(undefined)).toBe(false);
    expect(isServerRespawnActive(0)).toBe(false);
    expect(isServerRespawnActive(12)).toBe(true);
  });

  test('established lives/score do not snap back to a fresh spawn', () => {
    expect(isSilentHudReset(2, 210, 3, 0)).toBe(true);
    expect(isSilentHudReset(3, 210, 3, 0)).toBe(true);
    expect(isSilentHudReset(3, 0, 3, 0)).toBe(false);
    expect(isSilentHudReset(2, 210, 1, 210)).toBe(false);
    expect(isSilentHudReset(2, 210)).toBe(false);
    expect(isSilentHudReset(0, 210, 3, 0)).toBe(false);
  });

  test.each(SHIP_KINDS)('$kind explodes and flashes on a boundary hit', ({ options }) => {
    const ship = new Ship(options);
    ship.health = 100;
    applyShipBoundaryDeath(ship);
    expect(ship.health).toBe(0);
    expect(ship.exploding).toBe(true);
    expect(ship.impactFlashFrames).toBeGreaterThan(0);
  });

  test.each(SHIP_KINDS)('$kind explodes and flashes on an asteroid hit', ({ options }) => {
    const ship = new Ship(options);
    ship.health = 100;
    applyShipLethalCollision(ship, 'asteroid');
    expect(ship.health).toBe(0);
    expect(ship.exploding).toBe(true);
    expect(ship.impactFlashFrames).toBeGreaterThan(0);
  });
});

describe('shared ship collision immunity', () => {
  test('treats exploding, dead, and blinking ships as immune', () => {
    expect(isShipCollisionImmune({ exploding: true, health: 100, blinkCount: 0 })).toBe(true);
    expect(isShipCollisionImmune({ exploding: false, health: 0, blinkCount: 0 })).toBe(true);
    expect(isShipCollisionImmune({ exploding: false, health: 100, blinkCount: 3 })).toBe(true);
    expect(isShipCollisionImmune({ exploding: false, health: 100, blinkCount: 0 })).toBe(false);
  });

  test('a local pilot starts protected while a remote hull waits for server protection', () => {
    const local = new Ship({ isLocalPlayer: true });
    const remote = new Ship();

    expect(local.blinkCount).toBe(
      Math.ceil(SHIP.INVINCIBILITY_DURATION_FRAMES / SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES)
    );
    expect(local.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES);
    expect(local.blinkOn).toBe(true);
    expect(isShipCollisionImmune(local)).toBe(true);
    expect(remote.blinkCount).toBe(0);
    expect(remote.spawnProtectionTimer).toBe(0);
    expect(isShipCollisionImmune(remote)).toBe(false);
  });

  test('applyShipSpawnProtection arms the same blink window for any ship', () => {
    const ship = new Ship();
    applyShipSpawnProtection(ship);
    expect(ship.blinkCount).toBe(
      Math.ceil(SHIP.INVINCIBILITY_DURATION_FRAMES / SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES)
    );
    expect(ship.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES);
    expect(ship.blinkOn).toBe(true);
  });

  test('playerDamaged must not raise health on ignored hits', () => {
    expect(shouldApplyDamagedHealth(0, 100, false)).toBe(false);
    expect(shouldApplyDamagedHealth(100, 100, false)).toBe(false);
    expect(shouldApplyDamagedHealth(100, 75, false)).toBe(true);
    expect(shouldApplyDamagedHealth(25, 0, true)).toBe(true);
  });

  test('a leftover server timer syncs remaining blink instead of restacking a full window', () => {
    const ship = new Ship();
    ship.blinkCount = 0;
    ship.spawnProtectionTimer = 0;
    ship.health = 100;
    applySharedShipRespawnCue(ship, false, 12);
    expect(ship.blinkCount).toBe(Math.ceil(12 / SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES));
    expect(ship.blinkCount).toBeLessThan(
      Math.ceil(SHIP.INVINCIBILITY_DURATION_FRAMES / SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES)
    );
    applyShipSpawnProtectionForRemainingFrames(ship, 3);
    expect(ship.blinkCount).toBe(1);
    expect(ship.spawnProtectionTimer).toBe(3);
  });

  test('an explicit server timer of 0 clears leftover blink', () => {
    const ship = new Ship();
    applyShipSpawnProtection(ship);
    applySharedShipRespawnCue(ship, false, 0);
    expect(ship.blinkCount).toBe(0);
    expect(ship.spawnProtectionTimer).toBe(0);
    clearShipSpawnProtection(ship);
    expect(ship.blinkCount).toBe(0);
  });

  test('dead non-exploding hulls are not drawn', () => {
    expect(shouldDrawShipHull({ exploding: false, health: 100 })).toBe(true);
    expect(shouldDrawShipHull({ exploding: true, health: 0 })).toBe(false);
    expect(shouldDrawShipHull({ exploding: false, health: 0 })).toBe(false);
  });
});

describe('client blink after a heal-leak', () => {
  test('updateFromServer arms blink when server still has spawn protection', () => {
    const player = new Player({
      id: 'local',
      name: 'Local',
      type: 'local',
      input: new MockPlayerInput(),
    });
    player.ship.blinkCount = 0;
    player.ship.spawnProtectionTimer = 0;
    player.ship.health = 100;
    player.ship.exploding = false;

    player.updateFromServer({
      health: 100,
      exploding: false,
      spawnProtectionTimer: 180,
    });

    expect(player.ship.blinkCount).toBeGreaterThan(0);
  });

  test('nearby respawn releases the latch so a later zero-vel snapshot cannot freeze the ship', () => {
    const player = new Player({
      id: 'local',
      name: 'Local',
      type: 'local',
      input: new MockPlayerInput(),
    });
    player.ship.health = 0;
    player.ship.exploding = true;
    player.ship.position = { x: 0, y: 0 };
    player.ship.velocity = { x: 3, y: 0 };

    player.updateFromServer({
      health: 0,
      exploding: true,
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
    });
    player.updateFromServer({
      health: 100,
      exploding: false,
      position: { x: 10, y: 0 },
      velocity: { x: 0, y: 0 },
      spawnProtectionTimer: 180,
    });

    player.ship.velocity.x = 5;
    player.updateFromServer({
      health: 100,
      exploding: false,
      position: { x: 10, y: 0 },
      velocity: { x: 0, y: 0 },
    });

    expect(player.ship.velocity.x).toBe(5);
  });

  test('resetCombatLifecycle drops leftover explode and blink flags', () => {
    const player = new Player({
      id: 'local',
      name: 'Local',
      type: 'local',
      input: new MockPlayerInput(),
    });
    player.ship.health = 0;
    player.ship.exploding = true;
    player.ship.explodeTime = 4;
    player.ship.blinkCount = 12;
    player.ship.spawnProtectionTimer = 6;
    player.ship.velocity = { x: 2, y: 1 };

    player.resetCombatLifecycle();

    expect(player.ship.exploding).toBe(false);
    expect(player.ship.explodeTime).toBe(0);
    expect(player.ship.blinkCount).toBe(0);
    expect(player.ship.spawnProtectionTimer).toBe(0);
    expect(player.ship.velocity).toEqual({ x: 0, y: 0 });
  });

  test('updateFromServer writes position into the existing ship vectors', () => {
    const player = new Player({
      id: 'remote',
      name: 'Remote',
      type: 'remote',
      input: new MockPlayerInput(),
    });
    const position = player.ship.position;
    const velocity = player.ship.velocity;

    player.updateFromServer({
      position: { x: 120, y: -40 },
      velocity: { x: 2, y: 3 },
      angle: 1.2,
    });

    expect(player.ship.position).toBe(position);
    expect(player.ship.velocity).toBe(velocity);
    expect(position).toEqual({ x: 120, y: -40 });
    expect(velocity).toEqual({ x: 2, y: 3 });
    expect(player.ship.angle).toBe(1.2);
  });

  test('getStateForNetwork reuses the same envelope object', () => {
    const player = new Player({
      id: 'local',
      name: 'Local',
      type: 'local',
      input: new MockPlayerInput(),
    });
    const first = player.getStateForNetwork();
    player.ship.angle = 0.5;
    const second = player.getStateForNetwork();
    expect(second).toBe(first);
    expect(second.angle).toBe(0.5);
  });
});

describe('remote ship lifecycle is the same 60 Hz clock', () => {
  test('remote blink expires so the ship is hittable after invuln', () => {
    const player = new Player({
      id: 'remote',
      name: 'Remote',
      type: 'remote',
      input: new MockPlayerInput(),
    });
    player.ship.health = 0;
    player.ship.exploding = true;
    player.updateFromServer({ health: 100, exploding: false });
    expect(isShipCollisionImmune(player.ship)).toBe(true);

    player.ship.updateLifecycle(SHIP.INVINCIBILITY_DURATION_FRAMES);

    expect(player.ship.blinkCount).toBe(0);
    expect(isShipCollisionImmune(player.ship)).toBe(false);
  });

  test('remote lifecycle does not predict pose', () => {
    const player = new Player({
      id: 'remote',
      name: 'Remote',
      type: 'remote',
      input: new MockPlayerInput(),
    });
    const origin = { x: 40, y: 80 };
    player.ship.position = origin;
    player.ship.velocity = { x: 5, y: 0 };
    player.ship.thrusting = true;
    player.ship.updateLifecycle(10);
    expect(player.ship.position).toEqual(origin);
  });
});

describe('server ship respawn lifecycle', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('human explosion end does not reset an already-scheduled respawn timer', () => {
    const ws = new RecordingSocket();
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });

    engine.handlePlayerDamage('p1', 'boundary', player.health);
    const afterDeath = engine.getPlayer('p1');
    expect(afterDeath?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
    expect(afterDeath?.explodeTime).toBe(SHIP.EXPLODE_DURATION_FRAMES);

    engine.entityManager.updateExplosions();
    engine.entityManager.updateRespawns();
    engine.entityManager.updateExplosions();
    engine.entityManager.updateRespawns();

    const midExplosion = engine.getPlayer('p1');
    expect(midExplosion?.exploding).toBe(true);
    expect(midExplosion?.health).toBe(0);
    expect(midExplosion?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES - 2);
    expect(midExplosion?.respawnTimer).not.toBe(SHIP.RESPAWN_DELAY_FRAMES);
  });

  test('wall kill respawns as soon as the explode window ends — no corpse freeze', () => {
    const ws = new RecordingSocket();
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.handlePlayerDamage('p1', 'boundary', player.health);

    for (let i = 0; i < SHIP.EXPLODE_DURATION_FRAMES; i++) {
      engine.advanceCombatFrame();
    }

    const afterExplosion = engine.getPlayer('p1');
    expect(afterExplosion?.exploding).toBe(false);
    expect(afterExplosion?.health).toBe(afterExplosion?.maxHealth);
    expect(afterExplosion?.respawnTimer).toBeUndefined();
    expect(afterExplosion?.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES);
  });

  test('respawn grants a full protection window and holds an anchor', () => {
    const ws = new RecordingSocket();
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 3100, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.handlePlayerDamage('p1', 'asteroid', player.health);

    for (let i = 0; i < SHIP.RESPAWN_DELAY_FRAMES; i++) {
      engine.entityManager.updateExplosions();
      engine.entityManager.updateRespawns();
    }

    const respawned = engine.getPlayer('p1');
    expect(respawned?.health).toBe(respawned?.maxHealth);
    expect(respawned?.respawnTimer).toBeUndefined();
    expect(respawned?.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES);
    expect(respawned?.respawnAnchor).toEqual(respawned?.position);
    expect(isStaleDeathPose(respawned?.respawnAnchor, { x: 3100, y: 0 })).toBe(true);
    expect(isStaleDeathPose(respawned?.respawnAnchor, respawned?.position)).toBe(false);
  });

  test('gameTime keeps advancing after the last player leaves', async () => {
    engine.startGameLoop();
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const beforeLeave = engine.getDiagnostics().gameTime;
    expect(beforeLeave).toBeGreaterThan(0);

    engine.removePlayer('p1');
    expect(engine.isGamePaused()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterLeave = engine.getDiagnostics().gameTime;
    expect(afterLeave).toBeGreaterThanOrEqual(beforeLeave);
  });
});
