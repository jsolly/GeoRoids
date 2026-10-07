import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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

  test('the last pilot leaving discards unheard ejections before a later join', () => {
    world.clearAsteroids();
    addRock();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    world.entity(alice).equipment = ['resource_tap'];
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
    world.disconnect(alice);
    expect(world.engine.isGamePaused()).toBe(true);
    const bob = world.join('Bob', { x: 0, y: 0 });
    expect(bob.socket.received('tapEjected')).toEqual([]);
    expect(world.engine.drainTapEjections()).toEqual([]);
  });

  test.each(['release', 'death'] as const)(
    '%s after the first canister stops the remaining drops',
    (cause) => {
      world.clearAsteroids();
      addRock();
      alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
      world.entity(alice).equipment = ['resource_tap'];
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
