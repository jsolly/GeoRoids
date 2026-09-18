import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GROWTH } from '../../../shared/shipGrowth';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import {
  GameServerWorld,
  type Pilot,
  useQuietServerConsole,
} from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

describe('A Hauler Resource Tap extracts four canisters and leaves the rock', () => {
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

  test('a tap ejects four spaced collectible canisters without destroying the asteroid', () => {
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

    const spawnFrames: number[] = [];
    let previousCount = 0;
    for (let frame = 1; frame <= SHIP_ABILITY.TAP_EXTRACT_FRAMES; frame++) {
      world.engine.tickAbilities();
      const count = world.engine.getLoot().filter((drop) => drop.kind === 'tap').length;
      if (count > previousCount) {
        expect(count).toBe(previousCount + 1);
        spawnFrames.push(frame);
        previousCount = count;
      }
    }
    expect(spawnFrames).toEqual([23, 45, 68, 90]);
    expect(world.engine.getLoot().reduce((sum, drop) => sum + drop.mass, 0)).toBeCloseTo(0.4);
    for (let frame = 0; frame < 90; frame++) {
      world.engine.tickAbilities();
    }
    expect(world.engine.getLoot()).toHaveLength(4);

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
    for (let frame = 0; frame < GROWTH.TAP_LOOT_EJECT_FRAMES; frame++) {
      world.engine.advanceOneFrame();
    }
    const settled = world.engine.getLoot().find((drop) => drop.id === tap.id);
    expect(settled).toBeDefined();
    world.engine.updatePlayer(alice.id, { position: { ...(settled?.position ?? tap.position) } });
    const collected = world.engine.collectLoot();
    expect(collected.some((entry) => entry.lootId === tap.id)).toBe(true);
    expect(world.entity(alice).score).toBeGreaterThanOrEqual(GROWTH.TAP_LOOT_SCORE);
  });

  test.each(['release', 'death'] as const)(
    '%s after the first canister stops the remaining drops',
    (cause) => {
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
      for (let frame = 0; frame < 23; frame++) {
        world.engine.tickAbilities();
      }
      expect(world.engine.getLoot().filter((drop) => drop.kind === 'tap')).toHaveLength(1);
      if (cause === 'death') {
        world.entity(alice).spawnProtectionTimer = 0;
        expect(
          world.engine.handleShipDamage(alice.id, 'asteroid', world.entity(alice).health)
            .isDestroyed
        ).toBe(true);
      } else {
        world.send(alice, {
          type: 'useAbility',
          id: alice.id,
          data: { kitId: 'hauler', abilityId: 'harpoon' },
        });
      }
      for (let frame = 0; frame < 100; frame++) {
        world.engine.tickAbilities();
      }
      expect(world.entity(alice).harpoonTargetId).toBeNull();
      expect(world.engine.getLoot().filter((drop) => drop.kind === 'tap')).toHaveLength(1);
    }
  );
});
