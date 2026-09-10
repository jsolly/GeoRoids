import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WebSocket } from 'ws';
import { GameEngine } from '../../../server/core/GameEngine';
import { DAMAGE } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { activateShield, isShieldBlockingLasers } from '../../../src/entities/ship/shipShield';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

describe('authoritative shield: lasers blocked, collisions still hurt', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('two snapshots agree when a human raises a shield', () => {
    const ws = {} as WebSocket;
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

  test('enemy laser does not change shielded player health on the server', () => {
    const ws = {} as WebSocket;
    const target = engine.addPlayer('target', 'Target', ws, { x: 0, y: 0 });
    engine.addPlayer('attacker', 'Attacker', ws, { x: 20, y: 0 });
    engine.entityManager.updateEntity('target', { spawnProtectionTimer: 0 });
    expect(engine.requestShield('target', true)).toBe(true);

    const healthBefore = target.health;
    const destroyed = engine.handlePlayerDamage('target', 'attacker', DAMAGE.LASER_HIT, 'laser');

    const after = engine.getPlayer('target');
    expect(destroyed).toBe(false);
    expect(after?.health).toBe(healthBefore);
    expect(after?.shieldActive).toBe(true);
    expect(after?.shieldFlashTime).toBeGreaterThan(0);
  });

  test('asteroid and ship collisions still damage a shielded player', () => {
    const ws = {} as WebSocket;
    engine.addPlayer('target', 'Target', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('target', { spawnProtectionTimer: 0 });
    expect(engine.requestShield('target', true)).toBe(true);

    engine.handlePlayerDamage('target', 'asteroid', DAMAGE.LASER_HIT);
    expect(engine.getPlayer('target')?.health).toBe(75);
    expect(engine.getPlayer('target')?.shieldActive).toBe(true);

    engine.handlePlayerDamage('target', 'rammer', 20, 'collision');
    expect(engine.getPlayer('target')?.health).toBe(55);
  });

  test('bots use the same shield fields and laser block as humans', () => {
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
    expect(engine.getBot(bot.id)?.health).toBe(40);

    engine.handleBotDamage(bot.id, 'asteroid', DAMAGE.LASER_HIT);
    expect(engine.getBot(bot.id)?.health).toBe(15);
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
    const ws = {} as WebSocket;
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
