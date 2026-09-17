import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GROWTH } from '../../../shared/shipGrowth';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import {
  GameServerWorld,
  type Pilot,
  useQuietServerConsole,
} from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

describe('A Hauler Resource Tap extract drops a canister and leaves the rock', () => {
  let world: GameServerWorld;
  let alice: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
  });

  afterEach(() => {
    world.dispose();
  });

  function addRock(): void {
    world.engine.addAsteroid({
      id: 'tap-rock',
      position: { x: 80, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 20,
      jaggedness: 0.4,
      rotation: 0,
      angularVelocity: 0,
      health: 20,
      maxHealth: 20,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });
  }

  test('a finished tap spawns collectible Tap loot without destroying the asteroid', () => {
    world.clearAsteroids();
    addRock();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    world.send(alice, {
      type: 'setHaulerUtility',
      id: alice.id,
      data: { utilityId: 'resource_tap' },
    });
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).harpoonTargetId).toBe('tap-rock');
    const healthBefore = world.engine.getAsteroid('tap-rock')?.health;

    for (let i = 0; i < SHIP_ABILITY.TAP_EXTRACT_FRAMES; i++) {
      world.tick();
    }

    const rock = world.engine.getAsteroid('tap-rock');
    const loot = world.engine.getLoot();
    expect(rock?.health).toBe(healthBefore);
    expect(rock).toBeDefined();
    expect(loot.some((drop) => drop.kind === 'tap')).toBe(true);
    const tap = loot.find((drop) => drop.kind === 'tap');
    expect(tap?.radius).toBe(GROWTH.TAP_LOOT_RADIUS);
    expect(world.entity(alice).harpoonTargetId).toBeNull();

    if (!tap) {
      throw new Error('expected tap loot');
    }
    expect(world.engine.collectLoot()).toEqual([]);
    world.engine.updatePlayer(alice.id, { position: { ...tap.position } });
    const collected = world.engine.collectLoot();
    expect(collected.some((entry) => entry.lootId === tap.id)).toBe(true);
    expect(world.entity(alice).score).toBeGreaterThanOrEqual(GROWTH.TAP_LOOT_SCORE);
  });
});
