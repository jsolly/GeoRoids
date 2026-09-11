import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

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

  test('without a reachable enemy the rock reels in, bounces away and coasts freely', () => {
    world.clearAsteroids();
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
    if (!rock) {
      throw new Error('Missing harpooned rock');
    }
    for (let frame = 0; frame < 70 && rock.velocity.x <= 0; frame++) {
      world.engine.advanceOneFrame();
    }
    expect(rock.velocity.x).toBeCloseTo(12);
    expect(rock.velocity.y).toBeCloseTo(0);
    const releasedPosition = { ...rock.position };
    const releasedVelocity = { ...rock.velocity };
    for (let frame = 0; frame < 3; frame++) {
      world.engine.advanceOneFrame();
    }
    expect(rock.position.x).toBeGreaterThan(releasedPosition.x);
    expect(rock.velocity).toEqual(releasedVelocity);
    expect(world.entity(alice).exploding).toBe(false);
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

  test('an ability request slings the authoritative rock toward an enemy in its momentum path once', () => {
    world.clearAsteroids();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler', factionId: 'ion' });
    const ahead = world.join('Ahead', { x: 600, y: 0 }, { factionId: 'ember' });
    world.join('Side', { x: 100, y: 150 }, { factionId: 'ember' });
    world.parkBots();
    world.wearOffJoinInvulnerability();
    world.engine.addAsteroid({
      id: 'sling-rock',
      position: { x: 100, y: 0 },
      velocity: { x: 2, y: 0 },
      size: 20,
      jaggedness: 0.4,
      rotation: 0,
      angularVelocity: 0,
      health: 20,
      maxHealth: 20,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });
    const rock = world.engine.getAsteroid('sling-rock');
    expect(rock?.velocity.x).toBe(12);
    expect(rock?.velocity.y).toBe(0);
    world.entity(ahead).position.y = 400;
    world.tick(10);
    expect(rock?.velocity.x).toBe(12);
    expect(rock?.velocity.y).toBe(0);
  });

  test('an off-path enemy makes the authoritative rock reel in before it bounces outward', () => {
    world.clearAsteroids();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler', factionId: 'ion' });
    world.join('Side', { x: 300, y: 400 }, { factionId: 'ember' });
    world.parkBots();
    world.wearOffJoinInvulnerability();
    world.engine.addAsteroid({
      id: 'reel-rock',
      position: { x: 180, y: 0 },
      velocity: { x: 2, y: 0 },
      size: 20,
      jaggedness: 0.4,
      rotation: 0,
      angularVelocity: 0,
      health: 20,
      maxHealth: 20,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    world.send(alice, {
      type: 'useAbility',
      id: alice.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });
    const rock = world.engine.getAsteroid('reel-rock');
    expect(rock?.velocity).toEqual({ x: 2, y: 0 });
    for (let frame = 0; frame < 4; frame++) {
      world.engine.advanceOneFrame();
    }
    expect(rock?.velocity.x).toBeLessThan(0);
    expect(rock?.velocity.y).toBe(0);
    let released = false;
    for (let frame = 0; frame < 70; frame++) {
      world.engine.advanceOneFrame();
      if (rock && rock.velocity.y > 5) {
        released = true;
        expect(Math.hypot(rock.position.x, rock.position.y)).toBeLessThan(100);
        expect(Math.hypot(rock.velocity.x, rock.velocity.y)).toBeCloseTo(12);
        const velocity = { ...rock.velocity };
        for (let coast = 0; coast < 3; coast++) {
          world.engine.advanceOneFrame();
        }
        expect(rock.velocity).toEqual(velocity);
        break;
      }
    }
    expect(released).toBe(true);
    expect(world.entity(alice).exploding).toBe(false);
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
