import { describe, expect, test } from 'vitest';

import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { GROWTH } from '../../../shared/shipGrowth';

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
    const entity = {
      position: { x: 0, y: 0 },
      mass: GROWTH.BASE_MASS,
    };
    const pellets = manager.spawnFromKill(entity, 1);
    expect(pellets.length).toBeGreaterThan(0);
    expect(pellets.every((drop) => drop.kind === 'wreckage')).toBe(true);

    manager.spawnShard({ x: 8, y: 8 }, 2);
    expect(manager.getAll().some((drop) => drop.kind === 'shard')).toBe(true);
    expect(manager.getAll().some((drop) => drop.kind === 'wreckage')).toBe(true);
  });

  test('remove is first-wins', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 0, y: 0 }, 0);
    expect(manager.remove(shard.id)?.id).toBe(shard.id);
    expect(manager.remove(shard.id)).toBeUndefined();
    expect(manager.getCount()).toBe(0);
  });
});
