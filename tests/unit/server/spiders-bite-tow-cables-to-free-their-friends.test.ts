import { expect, test, vi } from 'vitest';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { SPIDER } from '../../../shared/terrainSpider';
import { GameServerWorld, useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

function arrange() {
  const manager = new TerrainSpiderManager(() => 0.5);
  const owner = {
    id: 'hauler',
    position: { x: 7000, y: 3000 },
    health: 100,
    exploding: false,
    spawnProtectionTimer: 600,
  };
  const friend = manager.spawnSpider({ x: 7200, y: 3000 });
  if (!friend) {
    throw new Error('Missing captive spider');
  }
  const towedIds = new Set([friend.id]);
  const releaseTow = vi.fn(() => {
    towedIds.delete(friend.id);
  });
  const options = {
    players: [owner],
    towedIds,
    spiderTows: [{ ownerId: owner.id, spiderId: friend.id }],
    releaseTow,
  };
  return { manager, owner, friend, options, releaseTow };
}

test('a nearby spider approaches the cable and bites its midpoint without attacking the hauler', () => {
  const { manager, options, releaseTow } = arrange();
  const rescuer = manager.spawnSpider({ x: 7100, y: 3300 });
  if (!rescuer) {
    throw new Error('Missing rescuer');
  }
  for (let nowFrame = 1; nowFrame < 300 && releaseTow.mock.calls.length === 0; nowFrame++) {
    expect(manager.advance({ ...options, nowFrame })).toEqual([]);
  }
  expect(releaseTow).toHaveBeenCalledExactlyOnceWith('hauler', options.spiderTows[0]?.spiderId);
  const body = manager.getBody(rescuer.id);
  expect(body?.position.x).toBe(7100);
  expect(body?.position.y).toBeCloseTo(3000 + SPIDER.BITE_DISTANCE);
  manager.advance({ ...options, nowFrame: 301 });
  expect(releaseTow).toHaveBeenCalledTimes(1);
});

test.each(['rock', 'released', 'dead', 'dead owner'] as const)(
  '%s cannot attract cable rescuers or reinforcements',
  (kind) => {
    const { manager, owner, friend, options, releaseTow } = arrange();
    if (kind === 'rock') {
      options.spiderTows[0] = { ownerId: owner.id, spiderId: 'rock-1' };
    }
    if (kind === 'released') {
      options.towedIds.clear();
    }
    if (kind === 'dead') {
      manager.removeSpider(friend.id);
    }
    if (kind === 'dead owner') {
      owner.health = 0;
    }
    manager.advance({ ...options, nowFrame: 1 });
    manager.advance({ ...options, nowFrame: 1 + SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES });
    expect(manager.snapshot().spiders.length).toBeLessThanOrEqual(1);
    expect(releaseTow).not.toHaveBeenCalled();
  }
);

test('a living tow draws reinforcements every twelve seconds with bounded population and no relatch burst', () => {
  const { manager, options } = arrange();
  manager.advance({ ...options, nowFrame: 1 });
  manager.advance({ ...options, nowFrame: SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES });
  expect(manager.snapshot().spiders).toHaveLength(1);
  for (let interval = 1; interval <= 6; interval++) {
    manager.advance({ ...options, nowFrame: 1 + interval * SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES });
    expect(manager.snapshot().spiders).toHaveLength(
      Math.min(1 + interval, SPIDER.MAX_RESCUE_ROAMERS)
    );
  }
  for (const spider of manager.getBodies()) {
    if (!options.towedIds.has(spider.id)) {
      manager.removeSpider(spider.id);
    }
  }
  manager.advance({
    players: options.players,
    nowFrame: 2 + 6 * SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES,
  });
  manager.advance({ ...options, nowFrame: 3 + 6 * SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES });
  expect(manager.snapshot().spiders).toHaveLength(1);
});

test('scans repel a cable rescuer and starter sanctuary prevents rescue and reinforcements', () => {
  const { manager, owner, friend, options, releaseTow } = arrange();
  const rescuer = manager.spawnSpider({ x: 7100, y: 3020 });
  if (!rescuer) {
    throw new Error('Missing rescuer');
  }
  manager.advance({ ...options, players: [{ ...owner, scanning: true }], nowFrame: 1 });
  expect(releaseTow).not.toHaveBeenCalled();
  expect(manager.getBody(rescuer.id)?.position.x).toBeGreaterThan(7100);
  owner.position = { x: 700, y: 0 };
  const captive = manager.getBody(friend.id);
  if (!captive) {
    throw new Error('Missing captive');
  }
  captive.position = { x: 800, y: 0 };
  manager.advance({ ...options, nowFrame: 2 });
  manager.advance({ ...options, nowFrame: 2 + SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES });
  expect(releaseTow).not.toHaveBeenCalled();
  expect(manager.snapshot().spiders).toHaveLength(1);
});

test('the authoritative game clears the actual tow latch when a rescuer bites', () => {
  const world = new GameServerWorld();
  try {
    world.clearAsteroids();
    world.engine.clearSpiderField();
    const pilot = world.join('Hauler', { x: 4400, y: 2200 }, { kitId: 'hauler' });
    world.clearAsteroids();
    const friend = world.engine.spawnTerrainSpider({ x: 4500, y: 2200 });
    if (!friend) {
      throw new Error('Missing captive');
    }
    world.engine.setHaulerUtility(pilot.id, 'tow_cable');
    world.entity(pilot).abilityCooldownFrames = 0;
    expect(world.engine.useAbility(pilot.id)).toBe(true);
    expect(world.entity(pilot).harpoonTargetId).toBe(friend.id);
    world.engine.spawnTerrainSpider({ x: 4450, y: 2220 });
    const health = world.entity(pilot).health;
    world.engine.advanceOneFrame();
    expect(world.entity(pilot).harpoonTargetId).toBeNull();
    expect(world.entity(pilot).harpoonLatchPos).toBeUndefined();
    expect(world.entity(pilot).health).toBe(health);
    expect(world.engine.getSpiderField().spiders.some((spider) => spider.id === friend.id)).toBe(
      true
    );
  } finally {
    world.dispose();
  }
});

test('reinforcements honor the global cap and failed attempts wait a full rescue interval', () => {
  const { manager, owner, options } = arrange();
  for (let index = 1; index < SPIDER.MAX_ACTIVE; index++) {
    manager.spawnSpider({ x: 8000 + index, y: 4000 });
  }
  manager.advance({ ...options, nowFrame: 1 });
  manager.advance({ ...options, nowFrame: 1 + SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES });
  expect(manager.snapshot().spiders).toHaveLength(SPIDER.MAX_ACTIVE);
  for (const spider of manager.getBodies()) {
    if (!options.towedIds.has(spider.id)) {
      manager.removeSpider(spider.id);
    }
  }
  const blocker = { ...owner, id: 'bystander', position: { x: 5100, y: 3000 } };
  manager.advance({
    ...options,
    players: [owner, blocker],
    nowFrame: 1 + 2 * SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES,
  });
  expect(manager.snapshot().spiders).toHaveLength(1);
  manager.advance({ ...options, nowFrame: 2 + 2 * SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES });
  expect(manager.snapshot().spiders).toHaveLength(1);
  manager.advance({ ...options, nowFrame: 1 + 3 * SPIDER.RESCUE_SPAWN_INTERVAL_FRAMES });
  expect(manager.snapshot().spiders).toHaveLength(2);
});

test('a rescuer invalidates a pending bite at the pilot when it switches to the cable', () => {
  const { manager, owner, options } = arrange();
  owner.spawnProtectionTimer = 0;
  manager.spawnSpider({ x: 7000, y: 3020 });
  manager.advance({ players: [owner], nowFrame: 1 });
  const attack = manager.advance({ players: [owner], nowFrame: 2 })[0];
  expect(attack).toBeDefined();
  manager.advance({ ...options, nowFrame: 3 });
  if (attack) {
    expect(manager.isAttackActive(attack)).toBe(false);
  }
});

test('a nest guard ends its rescue chase after eight seconds and returns home before responding again', () => {
  const { manager, options } = arrange();
  const spawned = manager.spawnSpider({ x: 7100, y: 3700 });
  const guard = spawned ? manager.getBody(spawned.id) : undefined;
  if (!guard) {
    throw new Error('Missing guard');
  }
  guard.territory = {
    kind: 'guard',
    nestId: 'test-nest',
    home: { x: 7100, y: 3700 },
    activity: 'patrolling',
    chaseUntil: 0,
  };
  manager.advance({ ...options, nowFrame: 1 });
  expect(guard.phase).toBe('hunting');
  expect(guard.territory.chaseUntil).toBe(1 + SPIDER.NEST_CHASE_FRAMES);
  // The cable remains in range as the moving captive leads the guard away.
  guard.position = { x: 7100, y: 3300 };
  manager.advance({ ...options, nowFrame: SPIDER.NEST_CHASE_FRAMES });
  expect(guard.phase).toBe('hunting');
  expect(guard.territory.chaseUntil).toBe(1 + SPIDER.NEST_CHASE_FRAMES);
  manager.advance({ ...options, nowFrame: 1 + SPIDER.NEST_CHASE_FRAMES });
  expect(guard.territory.activity).toBe('returning');
  expect(guard.phase).toBe('scuttling');
  const returningY = guard.position.y;
  manager.advance({ ...options, nowFrame: 2 + SPIDER.NEST_CHASE_FRAMES });
  expect(guard.position.y).toBeGreaterThan(returningY);
  expect(guard.targetId).toBeNull();
  guard.position = { ...guard.territory.home };
  manager.advance({ ...options, nowFrame: 3 + SPIDER.NEST_CHASE_FRAMES });
  expect(guard.territory.activity).toBe('patrolling');
  manager.advance({ ...options, nowFrame: 4 + SPIDER.NEST_CHASE_FRAMES });
  expect(guard.phase).toBe('hunting');
  expect(guard.territory.chaseUntil).toBe(4 + 2 * SPIDER.NEST_CHASE_FRAMES);
});

test('a rescuer selects the nearer cable when two friends are being towed', () => {
  const { manager, owner, options, releaseTow } = arrange();
  const otherOwner = { ...owner, id: 'other-hauler', position: { x: 7000, y: 3100 } };
  const otherFriend = manager.spawnSpider({ x: 7200, y: 3100 });
  if (!otherFriend) {
    throw new Error('Missing second captive');
  }
  manager.spawnSpider({ x: 7100, y: 3130 });
  options.towedIds.add(otherFriend.id);
  manager.advance({
    ...options,
    players: [owner, otherOwner],
    spiderTows: [...options.spiderTows, { ownerId: otherOwner.id, spiderId: otherFriend.id }],
    nowFrame: 1,
  });
  expect(releaseTow).toHaveBeenCalledExactlyOnceWith(otherOwner.id, otherFriend.id);
});
