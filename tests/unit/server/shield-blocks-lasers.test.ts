import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { radiusFromMass } from '../../../shared/shipGrowth';
import { DAMAGE } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { activateShield, isShieldBlockingLasers } from '../../../src/entities/ship/shipShield';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { RecordingSocket } from '../../support/recordingSocket';

describe('authoritative shield: lasers reflect, collisions still hurt', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('two snapshots agree when a human raises a shield', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('a', 'Alpha', ws, { x: 0, y: 0 });
    engine.addPlayer('b', 'Bravo', ws, { x: 10, y: 0 });

    expect(engine.requestShield('a', true)).toBe(true);

    const snapshot = engine.getGameState();
    const entityA = snapshot.entities.find((entity) => entity.id === 'a');
    const entityB = snapshot.entities.find((entity) => entity.id === 'b');
    expect(entityA?.shieldActive).toBe(true);
    expect(entityA?.shieldTime).toBeGreaterThan(0);
    expect(entityB?.shieldActive).toBe(false);
  });

  test('Warden keeps the longer four-second F shield duration on the server', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('warden', 'Warden', ws, { x: 0, y: 0 }, undefined, 'warden', 'ion');
    engine.entityManager.updateEntity('warden', { spawnProtectionTimer: 0 });

    expect(engine.requestShield('warden', true)).toBe(true);
    expect(engine.getPlayer('warden')?.shieldTime).toBe(4 * 60);
  });

  test.each(['F shield', 'projected shield'])(
    'a swept enemy laser reflects from the %s without changing target health',
    (shield) => {
      const ws = new RecordingSocket();
      const target = engine.addPlayer(
        'target',
        'Target',
        ws,
        { x: 0, y: 100_000 },
        undefined,
        'dart',
        'ion'
      );
      engine.addPlayer(
        'attacker',
        'Attacker',
        ws,
        { x: -100, y: 100_000 },
        undefined,
        'dart',
        'ember'
      );
      for (const asteroid of engine.getAllAsteroids()) {
        engine.removeAsteroid(asteroid.id);
      }
      engine.entityManager.updateEntity('target', { spawnProtectionTimer: 0 });
      engine.entityManager.updateEntity('attacker', { spawnProtectionTimer: 0 });
      if (shield === 'projected shield') {
        engine.addPlayer(
          'warden',
          'Warden',
          ws,
          { x: 200, y: 100_000 },
          undefined,
          'warden',
          'ion'
        );
        expect(engine.useAbility('warden')).toBe(true);
        expect(target.shieldSourceId).toBe('warden');
        expect(target.shieldActive).toBe(false);
        expect(target.shieldTimer).toBeGreaterThan(0);
      } else {
        expect(engine.requestShield('target', true)).toBe(true);
      }

      const healthBefore = target.health;
      const attackerHealthBefore = engine.getPlayer('attacker')?.health ?? 0;
      const laser = engine.spawnLaser('attacker', { x: -100, y: 100_000 }, { x: 200, y: 0 });
      expect(laser).toBeDefined();
      engine.advanceLasersAndResolveHits();

      const after = engine.getPlayer('target');
      expect(after?.health).toBe(healthBefore);
      expect(after?.shieldActive || (after?.shieldTimer ?? 0) > 0).toBe(true);
      expect(after?.shieldFlashTime).toBeGreaterThan(0);
      expect(laser?.hasExploded).toBe(true);
      expect(laser?.bounces).toBe(1);
      expect(laser?.velocity.x).toBeLessThan(0);
      expect(engine.getPlayer('attacker')?.health).toBe(attackerHealthBefore - DAMAGE.LASER_HIT);
    }
  );

  test('a pointblank inward laser that starts inside the bubble reflects before hull damage', () => {
    const ws = new RecordingSocket();
    const target = engine.addPlayer(
      'target',
      'Target',
      ws,
      { x: 0, y: 100_000 },
      undefined,
      'dart',
      'ion'
    );
    engine.addPlayer('attacker', 'Attacker', ws, { x: 0, y: 100_000 }, undefined, 'dart', 'ember');
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }
    engine.entityManager.updateEntity('target', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('attacker', { spawnProtectionTimer: 0 });
    expect(engine.requestShield('target', true)).toBe(true);

    const radius = radiusFromMass(target.mass) * 1.1;
    const healthBefore = target.health;
    const laser = engine.spawnLaser('attacker', { x: radius, y: 100_000 }, { x: -20, y: 0 });
    expect(laser).toBeDefined();
    const hits = engine.resolveSpawnedLaserHits(laser?.id ?? 'missing');

    expect(hits).toEqual([]);
    expect(target.health).toBe(healthBefore);
    expect(laser?.hasExploded).toBe(false);
    expect(laser?.bounces).toBe(1);
    expect(laser?.velocity.x).toBeGreaterThan(0);
  });

  test('asteroid and ship collisions still damage a shielded player', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('target', 'Target', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('target', { spawnProtectionTimer: 0 });
    expect(engine.requestShield('target', true)).toBe(true);

    engine.handlePlayerDamage('target', 'asteroid', DAMAGE.LASER_HIT);
    expect(engine.getPlayer('target')?.health).toBe(75);
    expect(engine.getPlayer('target')?.shieldActive).toBe(true);

    engine.handlePlayerDamage('target', 'rammer', 20, 'collision');
    expect(engine.getPlayer('target')?.health).toBe(55);
  });

  test('bots use the same reflecting shield fields as humans', () => {
    const bots = engine.entityManager.createBots(1);
    const bot = bots[0];
    expect(bot).toBeDefined();
    if (!bot) {
      return;
    }
    engine.entityManager.updateEntity(bot.id, { spawnProtectionTimer: 0, health: 40 });

    const live = engine.getBot(bot.id);
    expect(live).toBeDefined();
    if (!live) {
      return;
    }
    expect(activateShield(live)).toBe(true);
    expect(isShieldBlockingLasers(live)).toBe(true);

    const destroyed = engine.handleBotDamage(bot.id, 'attacker', DAMAGE.LASER_HIT);
    expect(destroyed).toBe(false);
    expect(engine.getBot(bot.id)?.health).toBe(15);

    engine.handleBotDamage(bot.id, 'asteroid', DAMAGE.LASER_HIT);
    expect(engine.getBot(bot.id)?.health).toBe(0);
  });

  test('remote clients apply the same shield snapshot from the server', () => {
    const remote = new Player({
      id: 'remote',
      name: 'Remote',
      type: 'remote',
      input: new MockPlayerInput(),
    });
    remote.updateFromServer({
      health: 100,
      shieldActive: true,
      shieldTime: 90,
      shieldCooldown: 0,
      shieldFlashTime: 4,
    });
    expect(remote.ship.shieldActive).toBe(true);
    expect(remote.ship.shieldTime).toBe(90);
    expect(remote.ship.shieldFlashTime).toBe(4);
  });

  test('client cannot clobber shield state through a movement update', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('a', 'Alpha', ws, { x: 0, y: 0 });
    expect(engine.requestShield('a', true)).toBe(true);

    engine.updatePlayer('a', {
      shieldActive: false,
      shieldTime: 0,
      position: { x: 5, y: 5 },
    });

    const after = engine.getPlayer('a');
    expect(after?.shieldActive).toBe(true);
    expect(after?.position).toEqual({ x: 5, y: 5 });
  });
});
