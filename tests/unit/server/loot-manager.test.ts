import { describe, expect, test } from 'vitest';

import type { GameEntity } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { GROWTH } from '../../../shared/shipGrowth';
import { RecordingSocket } from '../../support/recordingSocket';

function collectorAt(position: { x: number; y: number }): GameEntity {
  return {
    exploding: false,
    health: 100,
    position,
  } as GameEntity;
}

describe('LootManager destroy-drop shards', () => {
  test('spawnShard drops a shard at the break site', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 40, y: -10 }, 12);

    expect(shard.kind).toBe('shard');
    expect(shard.position).toEqual({ x: 40, y: -10 });
    expect(shard.mass).toBe(GROWTH.SHARD_MASS);
    expect(shard.radius).toBe(GROWTH.LOOT_RADIUS);
    expect(manager.getCount()).toBe(1);
    expect(manager.get(shard.id)?.id).toBe(shard.id);
  });

  test('kill pellets stay wreckage and share the same field', () => {
    const manager = new LootManager(new RNGService(7));
    const engine = new GameEngine(7);
    try {
      const entity = engine.addPlayer('kill-pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
      const pellets = manager.spawnFromKill(entity, 1);
      expect(pellets.length).toBeGreaterThan(0);
      expect(pellets.every((drop) => drop.kind === 'wreckage')).toBe(true);

      manager.spawnShard({ x: 8, y: 8 }, 2);
      expect(manager.getAll().some((drop) => drop.kind === 'shard')).toBe(true);
      expect(manager.getAll().some((drop) => drop.kind === 'wreckage')).toBe(true);
    } finally {
      engine.stopGameLoop();
    }
  });

  test('remove is first-wins', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 0, y: 0 }, 0);
    expect(manager.remove(shard.id)?.id).toBe(shard.id);
    expect(manager.remove(shard.id)).toBeUndefined();
    expect(manager.getCount()).toBe(0);
  });

  test('nearby loot flies toward a living ship', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 64, y: 0 }, 20);
    manager.expire(1, [collectorAt({ x: 0, y: 0 })]);
    const after = manager.get(shard.id);
    expect(after?.position.x).toBeCloseTo(64 - GROWTH.LOOT_MAGNET_ACCEL);
    expect(after?.position.y).toBe(0);
  });

  test('loot magnet accumulates velocity across consecutive frames', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 80, y: 0 }, 20);
    manager.expire(20, [collectorAt({ x: 0, y: 0 })]);
    manager.expire(21, [collectorAt({ x: 0, y: 0 })]);
    const after = manager.get(shard.id);
    expect(after?.position.x).toBeCloseTo(80 - GROWTH.LOOT_MAGNET_ACCEL * (2 + GROWTH.LOOT_DRAG));
  });
});
