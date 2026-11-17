/* @vitest-environment node */
import { expect, test } from 'vitest';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import {
  REMAINS_LIFETIME_FRAMES,
  REMAINS_LIMIT,
  WorldRemains,
} from '../../../server/world/WorldRemains';
import { FurnaceField } from '../../../shared/furnaceField';
import { spiderAdvanceFixture } from '../../support/spiderAdvanceFixture';
import { GameServerWorld } from '../scenarios/support/gameServerWorld';

test('authoritative death leaves nearby decorative remains with no new collectible reward', () => {
  const world = new GameServerWorld();
  try {
    const pilot = world.join('Pilot', { x: 0, y: 0 });
    const near = world.join('Nearby', { x: 0, y: 0 }, { worldRemains: 1 });
    const far = world.join('Far away', { x: 0, y: 0 }, { worldRemains: 1 });
    const legacy = world.join('Cached v3 client', { x: 4100, y: 4000 });
    const actor = world.entity(pilot);
    actor.position = { x: 4000, y: 4000 };
    actor.spawnProtectionTimer = 0;
    world.entity(near).position = { x: 4100, y: 4000 };
    world.entity(far).position = { x: 20000, y: 20000 };
    const loot = world.engine.getLoot().length;
    world.engine.shipDamage.apply(actor.id, 'boundary', actor.health);
    world.broadcastGameState();
    const marker = world.snapshot(near).mapAssets.find((asset) => asset.kind === 'ship-remains');
    expect(marker?.position).toEqual({ x: 4000, y: 4000 });
    expect(world.snapshot(far).mapAssets.some((asset) => asset.kind === 'ship-remains')).toBe(
      false
    );
    expect(world.snapshot(legacy).mapAssets.some((asset) => asset.kind === 'ship-remains')).toBe(
      false
    );
    expect(world.engine.getLoot()).toHaveLength(loot);
    world.engine.shipDamage.apply(actor.id, 'boundary', 1000);
    expect(
      world.engine.getGameState().mapAssets.filter((asset) => asset.kind === 'ship-remains')
    ).toHaveLength(1);
  } finally {
    world.dispose();
  }
});

test('only the final dead guard leaves nest ruins; sleeping and replayed removal do not', () => {
  const remains = new WorldRemains();
  const manager = new TerrainSpiderManager(
    () => 0.5,
    new FurnaceField(),
    (nestPosition) => remains.add('nest-remains', nestPosition, 1)
  );
  const position = { x: 15000, y: 5000 };
  manager.advance(
    spiderAdvanceFixture({
      nowFrame: 1,
      players: [
        { id: 'pilot', position: { x: 13000, y: 5000 }, health: 100, exploding: false, radius: 0 },
      ],
      resources: () => [{ id: 'ore', position, value: 1 }],
    })
  );
  const guards = manager.snapshot().spiders;
  expect(guards.length).toBeGreaterThan(1);
  for (const guard of guards.slice(0, -1)) {
    manager.removeSpider(guard.id);
  }
  expect(remains.snapshot(1)).toEqual([]);
  const last = guards.at(-1);
  if (!last) {
    throw new Error('Missing guard');
  }
  manager.removeSpider(last.id);
  manager.removeSpider(last.id);
  expect(manager.snapshot().nests).toEqual([]);
  expect(remains.snapshot(1)).toEqual([
    expect.objectContaining({ kind: 'nest-remains', position }),
  ]);
});

test('death history has a fixed cap and expires without retaining mutable snapshot references', () => {
  const remains = new WorldRemains();
  for (let i = 0; i < REMAINS_LIMIT + 10; i++) {
    remains.add('ship-remains', { x: i, y: 0 }, i);
  }
  const markers = remains.snapshot(REMAINS_LIMIT + 10);
  expect(markers).toHaveLength(REMAINS_LIMIT);
  expect(markers[0]?.position.x).toBe(10);
  if (markers[0]) {
    markers[0].position.x = -1;
  }
  expect(remains.snapshot(200)[0]?.position.x).toBe(10);
  expect(remains.snapshot(REMAINS_LIFETIME_FRAMES + REMAINS_LIMIT + 10)).toEqual([]);
});
