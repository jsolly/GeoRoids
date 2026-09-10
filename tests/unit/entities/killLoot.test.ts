import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { applyShipMass, GROWTH, planKillLoot, radiusFromMass } from '../../../shared/shipGrowth';
import { RecordingSocket } from '../../support/recordingSocket';

describe('kill loot and growth', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(4242);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('human and bot deaths drop the same pellet count for the same mass', () => {
    const ws = new RecordingSocket();
    const human = engine.addPlayer('p1', 'Pilot', ws, { x: 20, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    applyShipMass(human, 4);

    const bots = engine.createBots(1);
    const bot = bots?.[0];
    assert.ok(bot);
    engine.entityManager.updateEntity(bot.id, {
      spawnProtectionTimer: 0,
      position: { x: -20, y: 0 },
    });
    applyShipMass(bot, 4);

    const expected = planKillLoot(4).pelletMasses.length;
    engine.handlePlayerDamage('p1', 'asteroid', human.health);
    engine.handleBotDamage(bot.id, 'asteroid', bot.health);

    const loot = engine.getLoot();
    expect(loot.length).toBe(expected * 2);
    expect(loot.every((drop) => drop.kind === 'wreckage')).toBe(true);
    expect(engine.getGameState().loot.map((drop) => drop.id)).toEqual(loot.map((drop) => drop.id));
  });

  test('two game-state snapshots share the same loot ids and poses', () => {
    const ws = new RecordingSocket();
    const victim = engine.addPlayer('victim', 'Victim', ws, { x: 50, y: 25 });
    engine.entityManager.updateEntity('victim', { spawnProtectionTimer: 0 });
    engine.handlePlayerDamage('victim', 'boundary', victim.health);

    const first = engine.getGameState();
    const second = engine.getGameState();
    expect(first.loot.length).toBeGreaterThan(0);
    expect(second.loot).toEqual(first.loot);
  });

  test('collecting kill loot grows the collector and removes the drop', () => {
    const ws = new RecordingSocket();
    const collector = engine.addPlayer('p1', 'Collector', ws, { x: 200, y: 0 });
    const victim = engine.addPlayer('p2', 'Victim', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p2', { spawnProtectionTimer: 0 });

    engine.handlePlayerDamage('p2', 'p1', victim.health);
    const loot = engine.getLoot();
    const pellet = loot[0];
    assert.ok(pellet);

    engine.updatePlayer('p1', { position: { ...pellet.position } });
    const before = collector.mass;
    const collected = engine.collectLoot();

    expect(collected).toHaveLength(1);
    expect(collected[0]?.collectorId).toBe('p1');
    expect(collector.mass).toBeGreaterThan(before);
    expect(collector.maxHealth).toBeGreaterThan(100);
    expect(radiusFromMass(collector.mass)).toBeGreaterThan(radiusFromMass(GROWTH.BASE_MASS));
    expect(engine.getLoot().some((drop) => drop.id === pellet.id)).toBe(false);
  });

  test('only the first overlapping ship collects a drop', () => {
    const ws = new RecordingSocket();
    const first = engine.addPlayer('p1', 'First', ws, { x: 400, y: 0 });
    const second = engine.addPlayer('p2', 'Second', ws, { x: 400, y: 40 });
    const victim = engine.addPlayer('p3', 'Victim', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p2', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p3', { spawnProtectionTimer: 0 });

    engine.handlePlayerDamage('p3', 'boundary', victim.health);
    const pellet = engine.getLoot()[0];
    assert.ok(pellet);

    engine.updatePlayer('p1', { position: { ...pellet.position } });
    engine.updatePlayer('p2', { position: { ...pellet.position } });
    const collected = engine.collectLoot();

    expect(collected).toHaveLength(1);
    expect(collected[0]?.collectorId).toBe('p1');
    expect(first.mass).toBeGreaterThan(GROWTH.BASE_MASS);
    expect(second.mass).toBe(GROWTH.BASE_MASS);
  });

  test('respawn returns a grown ship to base mass and HP', () => {
    const ws = new RecordingSocket();
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    applyShipMass(player, 5);
    expect(player.maxHealth).toBeGreaterThan(100);

    engine.handlePlayerDamage('p1', 'boundary', player.health);
    for (let i = 0; i < 200; i++) {
      engine.entityManager.updateExplosions();
      engine.entityManager.updateRespawns();
    }

    const respawned = engine.getPlayer('p1');
    expect(respawned?.mass).toBe(GROWTH.BASE_MASS);
    expect(respawned?.maxHealth).toBe(100);
    expect(respawned?.health).toBe(100);
  });
});
