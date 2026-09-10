import { afterEach, assert, beforeEach, describe, expect, test } from 'vitest';
import type { WebSocket } from 'ws';
import {
  KILL_SCORE,
  killScoreFor,
  shouldAwardHumanKillPoints,
} from '../../../server/core/combatScoring';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHIP } from '../../../src/constants';

function firstBot(engine: GameEngine) {
  const bots = engine.createBots(1);
  assert.exists(bots);
  const bot = bots?.[0];
  assert.exists(bot);
  return bot;
}

describe('shared combat scoring helpers', () => {
  test('kill scores stay 200 for humans and 50 for bots', () => {
    expect(killScoreFor('human')).toBe(200);
    expect(killScoreFor('bot')).toBe(50);
    expect(KILL_SCORE.human).toBe(200);
    expect(KILL_SCORE.bot).toBe(50);
  });

  test('human kills require a different, existing attacker', () => {
    expect(shouldAwardHumanKillPoints('p2', 'p1', true)).toBe(true);
    expect(shouldAwardHumanKillPoints('p1', 'p1', true)).toBe(false);
    expect(shouldAwardHumanKillPoints('', 'p1', true)).toBe(false);
    expect(shouldAwardHumanKillPoints('p2', 'p1', false)).toBe(false);
  });
});

describe('GameEngine player vs bot damage wrappers', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('handlePlayerDamage does not damage bots; handleBotDamage does not damage humans', () => {
    const ws = {} as WebSocket;
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    const bot = firstBot(engine);
    engine.entityManager.updateEntity(bot.id, { spawnProtectionTimer: 0 });

    expect(engine.handlePlayerDamage(bot.id, 'p1', 25)).toBe(false);
    expect(engine.getBot(bot.id)?.health).toBe(100);

    expect(engine.handleBotDamage('p1', bot.id, 25)).toBe(false);
    expect(engine.getPlayer('p1')?.health).toBe(100);
  });

  test('destroying a human awards 200, spends a life, and schedules respawn', () => {
    const ws = {} as WebSocket;
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.addPlayer('p2', 'Rival', ws, { x: 10, y: 10 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });

    const destroyed = engine.handlePlayerDamage('p1', 'p2', 100);
    expect(destroyed).toBe(true);
    expect(engine.getPlayer('p2')?.score).toBe(KILL_SCORE.human);
    expect(engine.getPlayer('p1')?.lives).toBe(2);
    expect(engine.getPlayer('p1')?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
  });

  test('boundary / self kills do not award human kill points', () => {
    const ws = {} as WebSocket;
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });

    expect(engine.handlePlayerDamage('p1', 'boundary', 100)).toBe(true);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });

  test('destroying a bot awards 50 and leaves bot lives unchanged', () => {
    const ws = {} as WebSocket;
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    const bot = firstBot(engine);
    engine.entityManager.updateEntity(bot.id, { spawnProtectionTimer: 0 });
    const livesBefore = bot.lives;

    const destroyed = engine.handleBotDamage(bot.id, 'p1', bot.health);
    expect(destroyed).toBe(true);
    expect(engine.getPlayer('p1')?.score).toBe(KILL_SCORE.bot);
    expect(engine.getBot(bot.id)?.lives).toBe(livesBefore);
    expect(engine.getBot(bot.id)?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
  });

  test('ignored hits during respawn keep health and score unchanged', () => {
    const ws = {} as WebSocket;
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.addPlayer('p2', 'Rival', ws, { x: 10, y: 10 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.handlePlayerDamage('p1', 'p2', 100);
    const afterDeath = engine.getPlayer('p1');
    expect(afterDeath?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);

    expect(engine.handlePlayerDamage('p1', 'p2', 25)).toBe(false);
    expect(engine.getPlayer('p1')?.health).toBe(0);
    expect(engine.getPlayer('p2')?.score).toBe(KILL_SCORE.human);
  });
});
