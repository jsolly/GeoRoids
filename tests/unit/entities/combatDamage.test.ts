import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function firstBot(engine: GameEngine) {
  const bots = engine.createBots(1);
  const bot = bots?.[0];
  assert.ok(bot);
  return bot;
}

describe('Crew survival against world hazards', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('human and bot pilots cannot damage one another', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    const bot = firstBot(engine);
    engine.entityManager.updateEntity(bot.id, { spawnProtectionTimer: 0 });

    expect(engine.handleShipDamage(bot.id, 'p1', 25).isDestroyed).toBe(false);
    expect(engine.getBot(bot.id)?.health).toBe(100);

    expect(engine.handleShipDamage('p1', bot.id, 25).isDestroyed).toBe(false);
    expect(engine.getPlayer('p1')?.health).toBe(100);
  });

  test('environmental damage destroys a human, spends a life, and schedules respawn', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });

    const destroyed = engine.handleShipDamage('p1', 'asteroid', 100).isDestroyed;
    expect(destroyed).toBe(true);
    expect(engine.getPlayer('p1')?.lives).toBe(2);
    expect(engine.getPlayer('p1')?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
  });

  test('a boundary death preserves the pilot score', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });

    expect(engine.handleShipDamage('p1', 'boundary', 100).isDestroyed).toBe(true);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });

  test('environmental damage destroys a bot and leaves bot lives unchanged', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    const bot = firstBot(engine);
    engine.entityManager.updateEntity(bot.id, { spawnProtectionTimer: 0 });
    const livesBefore = bot.lives;

    const destroyed = engine.handleShipDamage(bot.id, 'asteroid', bot.health).isDestroyed;
    expect(destroyed).toBe(true);
    expect(engine.getBot(bot.id)?.lives).toBe(livesBefore);
    expect(engine.getBot(bot.id)?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
  });

  test('ignored hits during respawn keep health and score unchanged', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.handleShipDamage('p1', 'asteroid', 100);
    const afterDeath = engine.getPlayer('p1');
    expect(afterDeath?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);

    expect(engine.handleShipDamage('p1', 'asteroid', 25).isDestroyed).toBe(false);
    expect(engine.getPlayer('p1')?.health).toBe(0);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });
});
