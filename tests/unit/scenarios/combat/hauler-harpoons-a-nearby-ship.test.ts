import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A Hauler cannot harpoon a teammate ship', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    bob = world.join('Bob', { x: 80, y: 0 }, { kitId: 'surveyor' });
    world.clearAsteroids();
  });

  afterEach(() => {
    world.dispose();
  });

  test('a nearby teammate is ignored and both ships remain unharmed', () => {
    const bobHealth = world.entity(bob).health;
    const bobVelocity = { ...world.entity(bob).velocity };

    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });
    world.tick(4);

    expect(world.entity(alice).harpoonTargetId).toBeNull();
    expect(world.entity(alice).health).toBe(world.entity(alice).maxHealth);
    expect(world.entity(bob).health).toBe(bobHealth);
    expect(world.entity(bob).velocity).toEqual(bobVelocity);
  });

  test('a stale ship target is cleared by the authoritative asteroid tick', () => {
    world.engine.updatePlayer(alice.id, { harpoonTargetId: bob.id });
    expect(world.entity(alice).harpoonTargetId).toBe(bob.id);

    world.tick();

    expect(world.entity(alice).harpoonTargetId).toBeNull();
    expect(world.entity(bob).health).toBe(world.entity(bob).maxHealth);
  });
});
