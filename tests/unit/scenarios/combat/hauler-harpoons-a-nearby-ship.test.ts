import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A Hauler fires harpoon at a nearby ship', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
  });

  afterEach(() => {
    world.dispose();
  });

  test('only the Hauler latches and the foe is hauled in', () => {
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler', factionId: 'ion' });
    bob = world.join('Bob', { x: 80, y: 0 }, { kitId: 'dart', factionId: 'ember' });
    world.parkBots();
    world.clearAsteroids();

    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).harpoonTargetId).toBe(bob.id);
    expect(world.entity(alice).harpoonTimer).toBeGreaterThan(0);

    const before = world.entity(bob).velocity.x;
    world.tick(4);
    expect(world.entity(bob).velocity.x).toBeLessThan(before);
  });

  test('a target whose id contains the Hauler id is still pulled by the server tick', () => {
    const host = world.joinWithId(
      'host',
      'Host',
      { x: 0, y: 0 },
      { kitId: 'hauler', factionId: 'ion' }
    );
    const target = world.joinWithId(
      'target-host',
      'Target',
      { x: 80, y: 0 },
      { kitId: 'dart', factionId: 'ember' }
    );
    const hostEntity = world.entity(host);
    const targetEntity = world.entity(target);
    hostEntity.harpoonTimer = 2;
    hostEntity.harpoonTargetId = target.id;

    const before = targetEntity.velocity.x;
    world.tick();

    expect(targetEntity.velocity.x).toBeLessThan(before);
  });

  test('same-side mates are never latched', () => {
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler', factionId: 'ion' });
    bob = world.join('Bob', { x: 80, y: 0 }, { kitId: 'dart', factionId: 'ion' });
    world.parkBots();
    world.clearAsteroids();

    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).harpoonTargetId).toBeUndefined();
    expect(world.entity(alice).harpoonTimer).toBe(0);
  });

  test('timed ship shield blocks a Hauler latch', () => {
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler', factionId: 'ion' });
    bob = world.join('Bob', { x: 80, y: 0 }, { kitId: 'dart', factionId: 'ember' });
    world.parkBots();
    world.clearAsteroids();
    expect(world.engine.requestShield(bob.id, true)).toBe(true);
    expect(world.entity(bob).shieldActive).toBe(true);
    expect(world.entity(bob).shieldTimer).toBe(0);

    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).harpoonTargetId).toBeUndefined();
    expect(world.entity(alice).harpoonTimer).toBe(0);
    expect(world.entity(bob).shieldActive).toBe(true);
  });

  test('Warden shield blocks a Hauler latch', () => {
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler', factionId: 'ion' });
    bob = world.join('Bob', { x: 80, y: 0 }, { kitId: 'warden', factionId: 'ember' });
    world.parkBots();
    world.clearAsteroids();
    world.send(bob, {
      type: 'useAbility',
      id: bob.id,
      data: { kitId: 'warden', abilityId: 'shieldFocus' },
    });
    expect(world.entity(bob).shieldTimer).toBeGreaterThan(0);
    world.clearAsteroids();

    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).harpoonTargetId).toBeUndefined();
    expect(world.entity(alice).harpoonTimer).toBe(0);
    expect(world.entity(bob).shieldTimer).toBeGreaterThan(0);
  });
});
