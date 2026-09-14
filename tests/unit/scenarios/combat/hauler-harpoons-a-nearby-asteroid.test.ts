import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A Hauler tows a nearby asteroid to a furnace', () => {
  let world: GameServerWorld;
  let alice: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
  });

  afterEach(() => {
    world.dispose();
  });

  function addRock(id = 'haul-rock'): void {
    world.engine.addAsteroid({
      id,
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

  test('E attaches the nearest rock, preserves its initial momentum, and tows it when taut', () => {
    world.clearAsteroids();
    addRock();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    world.parkBots();
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    const rock = world.engine.getAsteroid('haul-rock');
    expect(rock).toBeDefined();
    expect(world.entity(alice).kitId).toBe('hauler');
    expect(world.entity(alice).harpoonTargetId).toBe('haul-rock');
    expect(rock?.velocity).toEqual({ x: 0, y: 0 });

    world.engine.updatePlayer(alice.id, { position: { x: -100, y: 0 } });
    world.tick();

    expect(world.entity(alice).harpoonTargetId).toBe('haul-rock');
    expect(rock?.velocity.x).toBeLessThan(0);
    expect(Math.abs(rock?.velocity.x ?? 0)).toBeLessThan(1);
    expect(world.entity(alice).exploding).toBe(false);
  });

  test('a second E releases the persistent tow without throwing the asteroid', () => {
    world.clearAsteroids();
    addRock();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    world.parkBots();
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });
    const rock = world.engine.getAsteroid('haul-rock');
    expect(rock).toBeDefined();
    const beforeRelease = { ...rock?.velocity };

    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).harpoonTargetId).toBeNull();
    expect(rock?.velocity).toEqual(beforeRelease);
  });

  test('a Surveyor cannot attach the Hauler tow to the same asteroid', () => {
    addRock();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'surveyor' });
    world.parkBots();
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'surveyor', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).harpoonTargetId).toBeNull();
    expect(world.engine.getAsteroid('haul-rock')?.velocity).toEqual({ x: 0, y: 0 });
  });
});
