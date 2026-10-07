import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { applyShipMass, GROWTH } from '../../../shared/shipGrowth';
import { RecordingSocket } from '../../support/recordingSocket';

describe('death, shared pickups and saved mass', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(4242);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('a lethal cargo-shield hit ejects points once without extra death debris', () => {
    const victim = engine.addPlayer('victim', 'Victim', new RecordingSocket(), { x: 50, y: 25 });
    engine.entityManager.updateEntity(victim.id, { spawnProtectionTimer: 0 });
    victim.cargo = 400;
    victim.score = 300;
    victim.equipment = ['survey_probe'];
    const before = engine.getLoot();
    engine.handleShipDamage(victim.id, 'boundary', victim.health + 40);
    expect(victim.cargo).toBe(0);
    expect(victim.score).toBe(300);
    expect(victim.equipment).toEqual(['survey_probe']);
    const after = engine.getLoot();
    expect(after.filter((drop) => drop.kind !== 'points')).toEqual(
      before.filter((drop) => drop.kind !== 'points')
    );
    expect(
      after
        .filter((drop) => drop.kind === 'points')
        .reduce((sum, drop) => sum + (drop.points ?? 0), 0)
    ).toBe(400);
    expect(victim.health).toBe(0);
    const first = engine.getGameState();
    const second = engine.getGameState();
    expect(first.loot).toEqual(after);
    expect(second.loot).toEqual(first.loot);
  });

  test('collecting a shard removes the drop without changing the collector', () => {
    const ws = new RecordingSocket();
    const collector = engine.addPlayer('p1', 'Collector', ws, { x: 200, y: 0 });
    const victim = engine.addPlayer('p2', 'Victim', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p2', { spawnProtectionTimer: 0 });

    const lootManager = new LootManager(new RNGService(42));
    lootManager.spawnShard(victim.position, 0);
    const loot = lootManager.getAll();
    const shard = loot[0];
    assert.ok(shard);

    engine.updatePlayer('p1', { position: { ...shard.position } });
    const before = {
      mass: collector.mass,
      maxHealth: collector.maxHealth,
      health: collector.health,
    };
    const collected = lootManager.collectOverlaps([collector]);

    expect(collected).toHaveLength(1);
    expect(collected[0]?.collector.id).toBe('p1');
    expect(collector.mass).toBe(before.mass);
    expect(collector.maxHealth).toBe(before.maxHealth);
    expect(collector.health).toBe(before.health);
    expect(lootManager.getAll().some((drop) => drop.id === shard.id)).toBe(false);
  });

  test('only the first overlapping ship collects a drop', () => {
    const ws = new RecordingSocket();
    const first = engine.addPlayer('p1', 'First', ws, { x: 400, y: 0 });
    const second = engine.addPlayer('p2', 'Second', ws, { x: 400, y: 40 });
    const victim = engine.addPlayer('p3', 'Victim', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p2', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p3', { spawnProtectionTimer: 0 });

    const lootManager = new LootManager(new RNGService(42));
    lootManager.spawnShard(victim.position, 0);
    const shard = lootManager.getAll()[0];
    assert.ok(shard);

    engine.updatePlayer('p1', { position: { ...shard.position } });
    engine.updatePlayer('p2', { position: { ...shard.position } });
    const collected = lootManager.collectOverlaps([first, second]);

    expect(collected).toHaveLength(1);
    expect(collected[0]?.collector.id).toBe('p1');
    expect(first.mass).toBe(GROWTH.BASE_MASS);
    expect(lootManager.getAll().some((drop) => drop.id === shard.id)).toBe(false);
    expect(second.mass).toBe(GROWTH.BASE_MASS);
  });

  test('respawn returns a saved heavy ship to base mass and HP', () => {
    const ws = new RecordingSocket();
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    applyShipMass(player, 5);
    expect(player.maxHealth).toBeGreaterThan(100);

    engine.handleShipDamage('p1', 'boundary', player.health);
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
