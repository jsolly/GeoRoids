import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BotShot } from '../../../server/ai/botController';
import { ARENA_RADIUS, CONTAIN_RADIUS } from '../../../server/ai/shipMotion';
import type { GameEntity } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import type { AsteroidData } from '../../../shared-types';
import { SHIP } from '../../../src/constants';

vi.mock('../../../setup/serverLogger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function firstBot(bots: GameEntity[] | null): GameEntity {
  assert.ok(bots, 'created bot list');
  const bot = bots[0];
  assert.ok(bot, 'created bot');
  return bot;
}

function parkAsteroidInFront(engine: GameEngine, bot: GameEntity, range = 220): AsteroidData {
  const rock: AsteroidData = {
    id: `bot-target-${bot.id}`,
    position: {
      x: bot.position.x + Math.cos(bot.angle) * range,
      y: bot.position.y - Math.sin(bot.angle) * range,
    },
    velocity: { x: 0, y: 0 },
    size: 25,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 100,
    maxHealth: 100,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    material: 'metal',
  };
  engine.addAsteroid(rock);
  delete bot.spawnProtectionTimer;
  bot.velocity = { x: 0, y: 0 };
  return rock;
}

describe('bot combat feel on the shared ship hull', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('a lined-up bot eventually fires a player-shaped shot', () => {
    const bots = engine.createBots(1);
    const bot = firstBot(bots);
    bot.position = { x: 0, y: 0 };
    bot.angle = 0;
    parkAsteroidInFront(engine, bot);

    let shots: BotShot[] = [];
    for (let i = 0; i < 20; i++) {
      shots = engine.updateBotMovement();
      if (shots.length > 0) {
        break;
      }
    }

    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0]?.botId).toBe(bot.id);
    expect(shots[0]?.laserStart).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
    });
    expect(shots[0]?.laserDirection).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
    });
  });

  test('bot shots enter the authoritative projectile field once', () => {
    const bots = engine.createBots(1);
    const bot = firstBot(bots);
    bot.position = { x: 0, y: 0 };
    bot.angle = 0;
    parkAsteroidInFront(engine, bot);
    for (let i = 0; i < 20; i++) {
      engine.updateBotMovement();
    }
    expect(engine.getServerLasers().length).toBeGreaterThan(0);
  });

  test('exploding bots do not move or shoot', () => {
    const bots = engine.createBots(1);
    const bot = firstBot(bots);
    parkAsteroidInFront(engine, bot);
    const origin = { ...bot.position };
    engine.handleShipDamage(bot.id, 'asteroid', bot.health);
    expect(bot.exploding).toBe(true);

    const shots = engine.updateBotMovement();
    expect(shots).toEqual([]);
    expect(bot.position).toEqual(origin);
  });

  test('bots stay inside the arena and never outrun the shared max speed', () => {
    const bots = engine.createBots(1);
    const bot = firstBot(bots);
    delete bot.spawnProtectionTimer;
    bot.position = { x: CONTAIN_RADIUS - 10, y: 0 };
    bot.velocity = { x: SHIP.MAX_VELOCITY, y: 0 };
    bot.angle = 0;

    for (let i = 0; i < 90; i++) {
      engine.updateBotMovement();
      expect(Math.hypot(bot.position.x, bot.position.y)).toBeLessThan(ARENA_RADIUS);
      expect(Math.hypot(bot.velocity.x, bot.velocity.y)).toBeLessThanOrEqual(
        SHIP.MAX_VELOCITY + 1e-6
      );
    }
  });
});
