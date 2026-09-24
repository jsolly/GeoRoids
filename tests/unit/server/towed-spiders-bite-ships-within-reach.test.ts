import { expect, test } from 'vitest';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { FurnaceField } from '../../../shared/furnaceField';
import { civicLot } from '../../../shared/furnaces';
import { SPIDER } from '../../../shared/terrainSpider';
import { GameServerWorld, useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

function arrange(furnaces = new FurnaceField()) {
  const manager = new TerrainSpiderManager(() => 0.5, furnaces);
  const spawned = manager.spawnSpider({ x: 7000, y: 3000 });
  const spider = spawned && manager.getBody(spawned.id);
  if (!spider) {
    throw new Error('Missing captive spider');
  }
  const owner = {
    id: 'hauler',
    position: { x: 6800, y: 3000 },
    health: 100,
    exploding: false,
  };
  const passer = { ...owner, id: 'passer', position: { x: 7000, y: 3040 } };
  const options = {
    players: [owner, passer],
    towedIds: new Set([spider.id]),
    spiderTows: [{ ownerId: owner.id, spiderId: spider.id }],
  };
  return { manager, spider, owner, passer, options };
}

test('a captive bites the nearest ship once per cooldown without chasing or dropping the tow', () => {
  const { manager, spider, owner, passer, options } = arrange();
  owner.position = { x: 6970, y: 3000 };
  const attacks = manager.advance({ ...options, nowFrame: 1 });
  expect(attacks).toEqual([{ spiderId: spider.id, targetId: owner.id, attackerId: 'spider' }]);
  const attack = attacks[0];
  if (!attack) {
    throw new Error('Expected bite');
  }
  expect(manager.isAttackActive(attack)).toBe(true);
  expect(spider.position).toEqual({ x: 7000, y: 3000 });
  owner.position.x = 6800;
  expect(manager.advance({ ...options, nowFrame: SPIDER.BITE_COOLDOWN_FRAMES })).toEqual([]);
  expect(manager.advance({ ...options, nowFrame: 1 + SPIDER.BITE_COOLDOWN_FRAMES })).toEqual([
    { spiderId: spider.id, targetId: passer.id, attackerId: 'spider' },
  ]);
  expect(options.towedIds.has(spider.id)).toBe(true);
});

test('crossing the cable or staying just outside bite range is safe', () => {
  const { manager, passer, options } = arrange();
  passer.position = { x: 6900, y: 3000 };
  expect(manager.advance({ ...options, nowFrame: 1 })).toEqual([]);
  passer.position = { x: 7000, y: 3000 + SPIDER.BITE_DISTANCE + 0.01 };
  expect(manager.advance({ ...options, nowFrame: 2 })).toEqual([]);
  passer.position.y = 3000 + SPIDER.BITE_DISTANCE;
  expect(manager.advance({ ...options, nowFrame: 3 })).toHaveLength(1);
});

test('a moving captive checks bite range at its new position', () => {
  const { manager, spider, passer, options } = arrange();
  passer.position = { x: 7060, y: 3000 };
  spider.velocity = { x: 20, y: 0 };
  expect(manager.advance({ ...options, nowFrame: 1 })).toHaveLength(1);
  expect(spider.position).toEqual({ x: 7020, y: 3000 });
});

test('a scan suppresses captive bites and dead or respawning ships are ignored', () => {
  const { manager, owner, passer, options } = arrange();
  expect(
    manager.advance({ ...options, players: [{ ...owner, scanning: true }, passer], nowFrame: 1 })
  ).toEqual([]);
  expect(
    manager.advance({ ...options, players: [owner, { ...passer, health: 0 }], nowFrame: 2 })
  ).toEqual([]);
  expect(
    manager.advance({ ...options, players: [owner, { ...passer, respawnTimer: 1 }], nowFrame: 3 })
  ).toEqual([]);
  expect(manager.advance({ ...options, nowFrame: 4 })).toHaveLength(1);
});

test('a captive inside starter protection cannot bite, and a protected hull outside it is safe', () => {
  const { manager, spider, owner, options } = arrange();
  spider.position = { x: SPIDER.STARTER_SAFE_RADIUS + SPIDER.HIT_RADIUS - 1, y: 0 };
  owner.position = { x: spider.position.x + 40, y: 0 };
  expect(manager.advance({ ...options, players: [owner], nowFrame: 1 })).toEqual([]);
  spider.position = { x: SPIDER.STARTER_SAFE_RADIUS + SPIDER.HIT_RADIUS + 1, y: 0 };
  owner.position = { x: SPIDER.STARTER_SAFE_RADIUS + 10, y: 0 };
  expect(manager.advance({ ...options, players: [{ ...owner, radius: 20 }], nowFrame: 2 })).toEqual(
    []
  );
});

test.each(['passer', 'owner', 'protected'] as const)(
  'the authoritative game applies normal lethal bites to %s while towing',
  (victim) => {
    const world = new GameServerWorld();
    try {
      world.clearAsteroids();
      world.engine.clearSpiderField();
      const owner = world.join('Hauler', { x: 7000, y: 3000 }, { kitId: 'hauler' });
      const passer = world.join('Passer', { x: 7500, y: 3000 });
      world.clearAsteroids();
      const spider = world.engine.spawnTerrainSpider({ x: 7100, y: 3000 });
      if (!spider) {
        throw new Error('Missing captive spider');
      }
      world.entity(owner).abilityCooldownFrames = 0;
      expect(world.engine.useAbility(owner.id)).toBe(true);
      expect(world.entity(owner).harpoonTargetId).toBe(spider.id);
      const target = victim === 'owner' ? owner : passer;
      world.entity(target).spawnProtectionTimer = victim === 'protected' ? 600 : 0;
      world.engine.updatePlayer(target.id, { position: { ...spider.position } });
      const health = world.entity(target).health;
      world.engine.advanceOneFrame();
      expect(world.entity(target).health).toBe(victim === 'protected' ? health : 0);
      if (victim !== 'owner') {
        expect(world.entity(owner).harpoonTargetId).toBe(spider.id);
      }
    } finally {
      world.dispose();
    }
  }
);

test('a towed nest guard can bite far from its old nest and cannot reset its cooldown by relatching', () => {
  const { manager, spider, passer, options } = arrange();
  spider.territory = {
    kind: 'guard',
    nestId: 'old-nest',
    home: { x: 4000, y: 3000 },
    activity: 'returning',
    chaseUntil: 0,
  };
  expect(manager.advance({ ...options, nowFrame: 1 })).toHaveLength(1);
  options.towedIds.clear();
  manager.advance({ ...options, nowFrame: 2 });
  options.towedIds.add(spider.id);
  passer.position = { ...spider.position };
  expect(manager.advance({ ...options, nowFrame: 3 })).toEqual([]);
  expect(manager.advance({ ...options, nowFrame: 1 + SPIDER.BITE_COOLDOWN_FRAMES })).toHaveLength(
    1
  );
});

test('a lit street furnace suppresses captive bites and consumes it before combat', () => {
  const furnaces = new FurnaceField();
  const lot = civicLot('street-1-0');
  if (!lot) {
    throw new Error('Missing street furnace');
  }
  furnaces.light(lot.id);
  const { manager, spider, owner, options } = arrange(furnaces);
  spider.position = { x: lot.position.x + 200, y: lot.position.y };
  owner.position = { ...spider.position };
  expect(manager.advance({ ...options, players: [owner], nowFrame: 1 })).toEqual([]);
  expect(manager.getBody(spider.id)).toBeDefined();
  spider.velocity = { x: -200, y: 0 };
  owner.position = { ...lot.position };
  expect(manager.advance({ ...options, players: [owner], nowFrame: 2 })).toEqual([]);
  expect(manager.getBody(spider.id)).toBeUndefined();
  expect(manager.snapshot().consumed).toEqual([
    expect.objectContaining({ id: spider.id, furnaceId: lot.id }),
  ]);
});
