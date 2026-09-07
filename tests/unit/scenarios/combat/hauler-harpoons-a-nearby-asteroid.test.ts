import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  GameServerWorld,
  useQuietServerConsole,
  type Pilot,
} from '../support/gameServerWorld';

useQuietServerConsole();

describe('A Hauler fires harpoon at a nearby rock', () => {
  let world: GameServerWorld;
  let alice: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
  });

  afterEach(() => {
    world.dispose();
  });

  test('only the Hauler latches and the rock is hauled in', () => {
    world.engine.addAsteroid({
      id: 'haul-rock',
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

    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    world.parkBots();
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).kitId).toBe('hauler');
    expect(world.entity(alice).harpoonTargetId).toBe('haul-rock');
    expect(world.entity(alice).harpoonTimer).toBeGreaterThan(0);

    world.tick(4);
    const rock = world.engine.getAsteroid('haul-rock');
    expect(rock).toBeDefined();
    expect(rock?.velocity.x).toBeLessThan(0);
  });

  test('a joined Hauler stays authoritative when the ability echoes its kit', () => {
    world.engine.addAsteroid({
      id: 'haul-rock',
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

    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    world.parkBots();
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).kitId).toBe('hauler');
    expect(world.entity(alice).harpoonTargetId).toBe('haul-rock');
    expect(world.entity(alice).harpoonTimer).toBeGreaterThan(0);
  });

  test('Dart cannot harpoon the same rock', () => {
    world.engine.addAsteroid({
      id: 'haul-rock',
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

    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'dart' });
    world.parkBots();
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'dart', abilityId: 'harpoon' },
    });

    expect(world.entity(alice).harpoonTargetId).toBeUndefined();
    expect(world.entity(alice).harpoonTimer).toBe(0);
    world.tick(4);
    expect(world.engine.getAsteroid('haul-rock')?.velocity.x).toBe(0);
  });
});
