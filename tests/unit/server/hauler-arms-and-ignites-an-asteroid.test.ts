import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ASTEROID_BOOST } from '../../../shared/asteroidBoost';
import { validateAsteroidDto } from '../../../shared/snapshotDto';
import type { AsteroidData, HaulerUtilityId } from '../../../shared-types';
import { Roid, RoidBelt } from '../../../src/entities/roid/Roid';
import { applyAsteroidKinematics } from '../../../src/network/services/asteroidFieldSync';
import {
  GameServerWorld,
  type Pilot,
  useQuietServerConsole,
} from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

describe('A Hauler arms an asteroid, then sends it on a fixed-direction burn', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;
  let rock: AsteroidData;

  function equip(pilot: Pilot, utilityId: HaulerUtilityId): void {
    world.send(pilot, { type: 'setHaulerUtility', id: pilot.id, data: { utilityId } });
  }
  function activate(pilot: Pilot): void {
    world.send(pilot, {
      type: 'useAbility',
      id: pilot.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });
  }
  function step(frames: number): void {
    for (let frame = 0; frame < frames; frame++) {
      world.engine.advanceOneFrame();
    }
  }
  function snapshotRock(pilot: Pilot): AsteroidData {
    world.broadcastGameState();
    const row = world.snapshot(pilot).asteroids.find((candidate) => candidate.id === rock.id);
    if (!row) {
      throw new Error('Snapshot omitted the boost rock');
    }
    return row;
  }

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    bob = world.join('Bob', { x: 0, y: 200 }, { kitId: 'hauler' });
    world.clearAsteroids();
    rock = {
      id: 'boost-rock',
      position: { x: 150, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 20,
      jaggedness: 0.4,
      rotation: 0,
      angularVelocity: 0.03,
      health: 75,
      maxHealth: 75,
      vertices: 4,
      offsets: [1, 1, 1, 1],
      material: 'metal',
    };
    world.engine.addAsteroid(rock);
    world.entity(alice).angle = 0;
    equip(alice, 'boost_coupling');
    equip(bob, 'boost_coupling');
  });
  afterEach(() => world.dispose());

  test('arming does not thrust; ignition survives steering and departure, then both clients clear the exhausted burn', () => {
    activate(alice);
    step(5);
    expect(rock.boost).toEqual({ phase: 'armed', ownerId: alice.id, angle: 0 });
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
    expect(rock.position).toEqual({ x: 150, y: 0 });
    expect(snapshotRock(bob).boost).toEqual(rock.boost);
    world.entity(alice).angle = Math.PI / 2;
    activate(alice);
    expect(world.entity(alice).harpoonTargetId).toBeNull();
    expect(world.entity(alice).abilityCooldownFrames).toBe(180);
    expect(rock.boost).toEqual({ phase: 'burning', angle: 0, remainingFrames: 180 });
    const aliceView = snapshotRock(alice);
    const bobView = snapshotRock(bob);
    expect(bobView.boost).toEqual(aliceView.boost);
    const local = new Roid({ ...rock.position }, rock.size, rock.id);
    applyAsteroidKinematics(local, bobView, { complete: true, snapPosition: true });
    const belt = new RoidBelt();
    belt.roids.push(local);
    world.engine.removePlayer(alice.id);
    step(1);
    belt.moveRoids();
    expect(rock.velocity.x).toBeCloseTo(ASTEROID_BOOST.acceleration);
    expect(local.velocity).toEqual(rock.velocity);
    expect(local.boost).toEqual(rock.boost);
    expect(bobView.boost).toEqual({ phase: 'burning', angle: 0, remainingFrames: 180 });
    step(179);
    expect(rock.boost).toBeNull();
    expect(rock.velocity.x).toBeCloseTo(ASTEROID_BOOST.maxSpeed);
    expect(rock.velocity.y).toBe(0);
    expect(rock.position.x).toBeGreaterThan(150);
    expect(rock.health).toBe(75);
    expect(world.engine.getLoot()).toEqual([]);
    applyAsteroidKinematics(local, snapshotRock(bob), { complete: true });
    expect(local.boost).toBeNull();
    const coast = { ...rock.velocity };
    step(1);
    expect(rock.velocity).toEqual(coast);
  });

  test.each(['boost_coupling', 'resource_tap', 'tow_cable'] as const)(
    'another pilot cannot take an armed or burning rock with %s',
    (utility) => {
      activate(alice);
      equip(bob, utility);
      activate(bob);
      expect(world.entity(bob).harpoonTargetId).toBeNull();
      expect(rock.boost).toEqual({ phase: 'armed', ownerId: alice.id, angle: 0 });
      // The transport must not allow Bob to ignite Alice's coupling by claiming her id.
      world.send(bob, {
        type: 'useAbility',
        id: alice.id,
        data: { kitId: 'hauler', abilityId: 'harpoon' },
      });
      expect(rock.boost?.phase).toBe('armed');
      activate(alice);
      activate(bob);
      expect(world.entity(bob).harpoonTargetId).toBeNull();
      expect(rock.boost?.phase).toBe('burning');
    }
  );

  test.each(['tool swap', 'range break', 'death', 'departure', 'transport close'] as const)(
    'an armed coupling cancels after %s without launching',
    (event) => {
      activate(alice);
      if (event === 'tool swap') {
        equip(alice, 'resource_tap');
      }
      if (event === 'range break') {
        world.entity(alice).position.x = -5000;
      }
      if (event === 'death') {
        world.entity(alice).spawnProtectionTimer = 0;
        const result = world.engine.handleShipDamage(alice.id, 'ricochet', 1000);
        expect(result.isDestroyed).toBe(true);
        expect(rock.boost).toBeNull();
      }
      if (event === 'departure') {
        world.engine.removePlayer(alice.id);
      }
      if (event === 'transport close') {
        world.dropTransport(alice);
      }
      if (event === 'tool swap' || event === 'departure' || event === 'transport close') {
        expect(rock.boost).toBeNull();
      }
      step(1);
      expect(rock.boost).toBeNull();
      expect(rock.velocity).toEqual({ x: 0, y: 0 });
      activate(bob);
      expect(world.entity(bob).harpoonTargetId).toBe(rock.id);
    }
  );

  test('a lethal hit after ignition leaves the independent burn running', () => {
    activate(alice);
    activate(alice);
    world.entity(alice).spawnProtectionTimer = 0;
    expect(world.engine.handleShipDamage(alice.id, 'ricochet', 1000).isDestroyed).toBe(true);
    expect(rock.boost?.phase).toBe('burning');
    step(1);
    expect(rock.velocity.x).toBeCloseTo(ASTEROID_BOOST.acceleration);
  });

  test('an out-of-range ignition cannot launch the rock before the next lifecycle tick', () => {
    activate(alice);
    world.entity(alice).position.x = -5000;
    activate(alice);
    step(1);
    expect(rock.boost).toBeNull();
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
  });

  test('destroying an armed rock releases its owner, and a removed burning rock cannot keep accelerating', () => {
    activate(alice);
    world.engine.removeAsteroid(rock.id);
    step(1);
    expect(world.entity(alice).harpoonTargetId).toBeNull();
    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    rock.boost = null;
    world.engine.addAsteroid(rock);
    world.entity(alice).abilityCooldownFrames = 0;
    activate(alice);
    activate(alice);
    step(1);
    const velocity = { ...rock.velocity };
    world.engine.removeAsteroid(rock.id);
    step(1);
    expect(rock.velocity).toEqual(velocity);
  });

  test('the last pilot leaving cancels an armed coupling even while the world is paused', () => {
    activate(alice);
    world.engine.removePlayer(bob.id);
    world.engine.removePlayer(alice.id);
    expect(rock.boost).toBeNull();
    step(5);
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
  });

  test('burn fuel pauses with an empty world and resumes when a pilot returns', () => {
    activate(alice);
    activate(alice);
    step(10);
    world.engine.removePlayer(bob.id);
    world.engine.removePlayer(alice.id);
    const remaining = rock.boost ? { ...rock.boost } : null;
    step(20);
    expect(rock.boost).toEqual(remaining);
    world.join('Carol', { x: 0, y: 0 });
    step(170);
    expect(rock.boost).toBeNull();
  });

  test('wire validation rejects malformed or unbounded burn state', () => {
    for (const boost of [
      { phase: 'armed', angle: 0 },
      { phase: 'burning', angle: Infinity, remainingFrames: 180 },
      { phase: 'burning', angle: 0, remainingFrames: 0 },
      { phase: 'burning', angle: 0, remainingFrames: 181 },
      { phase: 'burning', angle: 0, remainingFrames: 1.5 },
    ]) {
      const candidate = { ...rock, boost };
      expect(() => validateAsteroidDto(candidate)).toThrow();
    }
  });
});
