import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

describe('soft factions for humans and bots', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('join auto-balances humans and bots onto two sides', () => {
    const ws = new RecordingSocket();
    const a = engine.addPlayer('human-a', 'A', ws);
    const bots = engine.createBots(2) ?? [];
    const b = engine.addPlayer('human-b', 'B', ws);

    const sides = [a, b, ...bots].map((entity) => entity.factionId);
    const ion = sides.filter((faction) => faction === 'ion').length;
    const ember = sides.filter((faction) => faction === 'ember').length;
    expect(ion + ember).toBe(sides.length);
    expect(Math.abs(ion - ember)).toBeLessThanOrEqual(1);
  });

  test('humans and bots on the same side skip laser damage', () => {
    const ws = new RecordingSocket();
    const human = engine.addPlayer('human-1', 'Pilot', ws);
    engine.entityManager.updateEntity(human.id, {
      spawnProtectionTimer: 0,
      factionId: 'ion',
    });
    const bots = engine.createBots(2) ?? [];
    const allyBot = bots[0];
    assert.ok(allyBot, 'same-faction ally bot');
    engine.entityManager.updateEntity(allyBot.id, {
      spawnProtectionTimer: 0,
      factionId: 'ion',
    });

    const healthBefore = allyBot.health;
    const destroyed = engine.handleBotDamage(allyBot.id, human.id, 25);
    expect(destroyed).toBe(false);
    expect(engine.getBot(allyBot.id)?.health).toBe(healthBefore);
  });

  test('same-faction humans do not take laser damage from each other', () => {
    const ws = new RecordingSocket();
    const shooter = engine.addPlayer('human-ff-a', 'A', ws);
    const teammate = engine.addPlayer('human-ff-b', 'B', ws);
    engine.entityManager.updateEntity(shooter.id, {
      spawnProtectionTimer: 0,
      factionId: 'ember',
    });
    engine.entityManager.updateEntity(teammate.id, {
      spawnProtectionTimer: 0,
      factionId: 'ember',
    });

    const healthBefore = teammate.health;
    engine.handlePlayerDamage(teammate.id, shooter.id, 25);
    expect(engine.getPlayer(teammate.id)?.health).toBe(healthBefore);
  });

  test('opposite-faction lasers still damage humans and bots', () => {
    const ws = new RecordingSocket();
    const attacker = engine.addPlayer('human-atk', 'Atk', ws);
    const target = engine.addPlayer('human-tgt', 'Tgt', ws);
    engine.entityManager.updateEntity(attacker.id, {
      spawnProtectionTimer: 0,
      factionId: 'ion',
    });
    engine.entityManager.updateEntity(target.id, {
      spawnProtectionTimer: 0,
      factionId: 'ember',
    });

    const targetHealth = target.health;
    engine.handlePlayerDamage(target.id, attacker.id, 25);
    expect(engine.getPlayer(target.id)?.health).toBe(targetHealth - 25);

    const bots = engine.createBots(2) ?? [];
    const emberBot = bots.find((bot) => bot.factionId === 'ember') ?? bots[0];
    assert.ok(emberBot, 'opposite-faction ember bot');
    engine.entityManager.updateEntity(emberBot.id, {
      spawnProtectionTimer: 0,
      factionId: 'ember',
    });
    const botHealth = emberBot.health;
    engine.handleBotDamage(emberBot.id, attacker.id, 25);
    expect(engine.getBot(emberBot.id)?.health).toBe(botHealth - 25);
  });

  test('asteroid and boundary hits still damage teammates', () => {
    const ws = new RecordingSocket();
    const player = engine.addPlayer('human-env', 'Env', ws);
    engine.entityManager.updateEntity(player.id, { spawnProtectionTimer: 0 });
    const health = player.health;
    engine.handlePlayerDamage(player.id, 'asteroid', 25);
    expect(engine.getPlayer(player.id)?.health).toBe(health - 25);
    engine.handlePlayerDamage(player.id, 'boundary', 25);
    expect(engine.getPlayer(player.id)?.health).toBe(health - 50);
  });

  test('kills award personal score only — no team score on gameState', () => {
    const ws = new RecordingSocket();
    const attacker = engine.addPlayer('human-scorer', 'Scorer', ws);
    const ally = engine.addPlayer('human-ally', 'Ally', ws);
    const target = engine.addPlayer('human-victim', 'Victim', ws);
    engine.entityManager.updateEntity(attacker.id, {
      spawnProtectionTimer: 0,
      factionId: 'ion',
    });
    engine.entityManager.updateEntity(ally.id, {
      spawnProtectionTimer: 0,
      factionId: 'ion',
    });
    engine.entityManager.updateEntity(target.id, {
      spawnProtectionTimer: 0,
      factionId: 'ember',
      health: 25,
    });

    const allyScore = ally.score;
    engine.handlePlayerDamage(target.id, attacker.id, 25);
    expect(engine.getPlayer(attacker.id)?.score).toBe(200);
    expect(engine.getPlayer(ally.id)?.score).toBe(allyScore);

    const state = engine.getGameState();
    expect(state).not.toHaveProperty('teamScore');
    expect(state).not.toHaveProperty('teamWinner');
    for (const entity of state.entities) {
      expect(typeof entity.score).toBe('number');
    }
  });

  test('gameState includes faction for every ship', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('human-state', 'State', ws);
    engine.createBots(2);
    const state = engine.getGameState();
    expect(state.entities.length).toBeGreaterThan(0);
    for (const entity of state.entities) {
      expect(entity.factionId === 'ion' || entity.factionId === 'ember').toBe(true);
    }
  });
});
