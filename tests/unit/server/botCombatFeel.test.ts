import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BotShot } from '../../../server/ai/botController';
import { ARENA_RADIUS, CONTAIN_RADIUS } from '../../../server/ai/shipMotion';
import type { GameEntity } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

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

function parkHumanInFront(engine: GameEngine, bot: GameEntity, range = 220): GameEntity {
  const human = engine.entityManager.addHumanPlayer('human-pilot', 'Pilot', new RecordingSocket(), {
    x: bot.position.x + Math.cos(bot.angle) * range,
    y: bot.position.y - Math.sin(bot.angle) * range,
  });
  delete human.spawnProtectionTimer;
  human.velocity = { x: 0, y: 0 };
  human.factionId = bot.factionId === 'ion' ? 'ember' : 'ion';
  delete bot.spawnProtectionTimer;
  bot.velocity = { x: 0, y: 0 };
  return human;
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
    parkHumanInFront(engine, bot);

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

  test('queued shots drain once for the playerShoot broadcast path', () => {
    const bots = engine.createBots(1);
    const bot = firstBot(bots);
    bot.position = { x: 0, y: 0 };
    bot.angle = 0;
    parkHumanInFront(engine, bot);
    for (let i = 0; i < 20; i++) {
      engine.updateBotMovement();
    }
    const first = engine.consumeBotShots();
    const second = engine.consumeBotShots();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
  });

  test('exploding bots do not move or shoot', () => {
    const bots = engine.createBots(1);
    const bot = firstBot(bots);
    parkHumanInFront(engine, bot);
    const origin = { ...bot.position };
    engine.handleBotDamage(bot.id, 'test', bot.health);
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
