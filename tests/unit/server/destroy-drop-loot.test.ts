import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WebSocket } from 'ws';

import { GameEngine } from '../../../server/core/GameEngine';
import { LOOT_BLAST } from '../../../shared/lootBlast';
import { applyLootMass, GROWTH } from '../../../shared/shipGrowth';
import { ROID } from '../../../src/constants';

function addSmallAsteroid(engine: GameEngine, id: string, size = 12): void {
  engine.addAsteroid({
    id,
    position: { x: 20, y: 30 },
    velocity: { x: 2, y: -1 },
    size,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 10,
    maxHealth: 10,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  });
}

describe('destroy-drop shards on the #458 loot path', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(99);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('destroying a roid drops a shared shard in game state', () => {
    const ws = {} as WebSocket;
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    addSmallAsteroid(engine, 'roid-1', 12);

    const result = engine.handleAsteroidHit('roid-1', player.id, 'laser');

    expect(result.outcome).toBe('destroyed');
    const shards = engine.getLoot().filter((drop) => drop.kind === 'shard');
    expect(shards).toHaveLength(1);
    expect(shards[0]?.position).toEqual({ x: 20, y: 30 });
    expect(shards[0]?.mass).toBe(GROWTH.SHARD_MASS);
    expect(engine.getGameState().loot).toHaveLength(1);
    expect(engine.getDiagnostics().loot).toBe(1);
    expect(player.score).toBe(ROID.POINTS_SMALL);
  });

  test('collecting a shard uses existing mass growth and a small score', () => {
    const ws = {} as WebSocket;
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 20, y: 30 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    addSmallAsteroid(engine, 'roid-1', 12);
    engine.handleAsteroidHit('roid-1', player.id, 'laser');
    const beforeMass = player.mass ?? GROWTH.BASE_MASS;

    const collected = engine.collectLoot();

    expect(collected).toHaveLength(1);
    expect(player.mass).toBeCloseTo(applyLootMass(beforeMass, GROWTH.SHARD_MASS));
    expect(player.score).toBe(ROID.POINTS_SMALL + GROWTH.SHARD_SCORE);
    expect(engine.getLoot()).toHaveLength(0);
  });

  test('shooting a shard detonates it and damages nearby hulls', () => {
    const ws = {} as WebSocket;
    const shooter = engine.addPlayer('p1', 'Pilot', ws, { x: 20, y: 30 });
    const bystander = engine.addPlayer('p2', 'Near', ws, { x: 36, y: 30 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p2', { spawnProtectionTimer: 0 });
    addSmallAsteroid(engine, 'roid-1', 12);
    engine.handleAsteroidHit('roid-1', shooter.id, 'laser');
    const shard = engine.getLoot().find((drop) => drop.kind === 'shard');
    expect(shard).toBeDefined();

    const healthBefore = bystander.health;
    const blast = engine.handleLootExplode(shooter.id, shard!.id);

    expect(blast.success).toBe(true);
    expect(engine.getLoot()).toHaveLength(0);
    expect(blast.damagedIds).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(bystander.health).toBe(healthBefore - LOOT_BLAST.DAMAGE);
    expect(shooter.health).toBeLessThan(100);
  });

  test('blast pushes small roids away and leaves big ones', () => {
    const ws = {} as WebSocket;
    const shooter = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.addAsteroid({
      id: 'seed-roid',
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 12,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 10,
      maxHealth: 10,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    engine.addAsteroid({
      id: 'small-1',
      position: { x: 10, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 12,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 10,
      maxHealth: 10,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    engine.addAsteroid({
      id: 'big-1',
      position: { x: 12, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 50,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 10,
      maxHealth: 10,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });

    engine.handleAsteroidHit('seed-roid', shooter.id, 'laser');
    const shard = engine.getLoot().find((drop) => drop.kind === 'shard');
    expect(shard).toBeDefined();
    const blast = engine.handleLootExplode(shooter.id, shard!.id);

    expect(blast.success).toBe(true);
    expect(blast.pushedAsteroidIds).toContain('small-1');
    expect(blast.pushedAsteroidIds).not.toContain('big-1');
    expect(engine.getAsteroid('small-1')?.velocity.x).toBeGreaterThan(0);
    expect(engine.getAsteroid('big-1')?.velocity.x).toBe(0);
  });

  test('reset clears shards with the rest of the world', () => {
    const ws = {} as WebSocket;
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    addSmallAsteroid(engine, 'roid-1', 12);
    engine.handleAsteroidHit('roid-1', 'p1', 'laser');
    expect(engine.getDiagnostics().loot).toBe(1);

    engine.resetForTesting();
    expect(engine.getLoot()).toHaveLength(0);
    expect(engine.getDiagnostics().loot).toBe(0);
  });
});
