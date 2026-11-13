import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ASTEROID_BOOST, furnaceHeading } from '../../../shared/asteroidBoost';
import { furnaceReward, nearestFurnace } from '../../../shared/furnaces';
import { validateAsteroidDto } from '../../../shared/snapshotDto';
import type { AsteroidData, HaulerUtilityId } from '../../../shared-types';
import { resolveToolFlights } from '../../support/tool-flight';
import {
  GameServerWorld,
  type Pilot,
  useQuietServerConsole,
} from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

describe('A Hauler arms an asteroid, then sends it on a furnace-guided delivery', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;
  let rock: AsteroidData;

  function equip(pilot: Pilot, utilityId: HaulerUtilityId): void {
    if (utilityId !== 'tow_cable') {
      world.entity(pilot).equipment = [utilityId];
    }
    world.send(pilot, { type: 'setHaulerUtility', id: pilot.id, data: { utilityId } });
  }
  function activate(pilot: Pilot): void {
    world.send(pilot, {
      type: 'useAbility',
      id: pilot.id,
      data: {},
    });
    resolveToolFlights(world.engine);
  }
  function step(frames: number): void {
    for (let frame = 0; frame < frames; frame++) {
      world.engine.advanceOneFrame();
    }
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

  test.each(['boost_coupling', 'resource_tap', 'tow_cable'] as const)(
    'another pilot cannot take an armed or burning rock with %s',
    (utility) => {
      activate(alice);
      equip(bob, utility);
      activate(bob);
      expect(world.entity(bob).harpoonTargetId).toBeNull();
      expect(rock.boost).toEqual({
        phase: 'armed',
        ownerId: alice.id,
        angle: furnaceHeading(rock.position),
      });
      // The transport must not allow Bob to ignite Alice's coupling by claiming her id.
      world.send(bob, {
        type: 'useAbility',
        id: alice.id,
        data: {},
      });
      resolveToolFlights(world.engine);
      expect(rock.boost?.phase).toBe('armed');
      activate(alice);
      activate(bob);
      expect(world.entity(bob).harpoonTargetId).toBeNull();
      expect(rock.boost?.phase).toBe('burning');
    }
  );

  test('a lethal hit after ignition leaves the independent burn running', () => {
    activate(alice);
    activate(alice);
    world.entity(alice).spawnProtectionTimer = 0;
    expect(world.engine.handleShipDamage(alice.id, 'ricochet', 1000).isDestroyed).toBe(true);
    expect(rock.boost?.phase).toBe('burning');
    step(1);
    expect(Math.hypot(rock.velocity.x, rock.velocity.y)).toBeCloseTo(ASTEROID_BOOST.acceleration);
  });

  test('an out-of-range ignition cannot launch the rock before the next lifecycle tick', () => {
    activate(alice);
    world.entity(alice).position.x = -5000;
    activate(alice);
    step(1);
    expect(rock.boost).toBeNull();
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
  });

  test('the last pilot leaving cancels an armed coupling even while the world is paused', () => {
    activate(alice);
    world.engine.removePlayer(bob.id);
    world.engine.removePlayer(alice.id);
    expect(rock.boost).toBeNull();
    step(5);
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
  });

  test('guidance pauses with an empty world and resumes when a pilot returns', () => {
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
    expect(rock.boost?.phase).toBe('burning');
  });

  test('ignited cargo passes through a ship and its tow without damaging either', () => {
    activate(alice);
    activate(alice);
    const bobActor = world.entity(bob);
    equip(bob, 'tow_cable');
    const towed = { ...rock, id: 'other-cargo', boost: null, position: { x: 0, y: 250 } };
    world.engine.addAsteroid(towed);
    bobActor.angle = Math.atan2(
      bobActor.position.y - towed.position.y,
      towed.position.x - bobActor.position.x
    );
    activate(bob);
    expect(bobActor.harpoonTargetId).toBe(towed.id);
    bobActor.position = { ...rock.position };
    bobActor.spawnProtectionTimer = 0;
    towed.position = { ...rock.position };
    const health = bobActor.health;
    world.engine.resolveAuthoritativeCombat();
    expect(bobActor.health).toBe(health);
    expect(world.engine.getAsteroid(towed.id)).toBe(towed);
    expect(world.engine.getAsteroid(rock.id)).toBe(rock);
  });

  test('weapons and new scans cannot affect ignited cargo', () => {
    activate(alice);
    activate(alice);
    const original = structuredClone(rock);
    expect(world.engine.applyLaserAsteroidHit(rock.id, bob.id).outcome).toBe('ignored');
    const scout = world.join('Scout', { x: 150, y: 0 });
    world.engine.useAbility(scout.id);
    expect(rock).toEqual(original);
    const laser = world.engine.spawnLaser(bob.id, { x: 100, y: 0 }, { x: 8, y: 0 });
    expect(laser).toBeTruthy();
    for (let frame = 0; frame < 15; frame++) {
      expect(world.engine.advanceLasersAndResolveHits()).toEqual([]);
    }
    expect(laser?.hasExploded).toBe(false);
    expect(laser?.position.x).toBeGreaterThan(rock.position.x + rock.size);
    expect(rock).toEqual(original);
  });

  test('delivery still pays its original launcher after the launcher dies', () => {
    activate(alice);
    activate(alice);
    world.entity(alice).health = 0;
    const furnace = nearestFurnace(rock.position);
    const before = world.entity(alice).score;
    const points = furnaceReward(rock);
    rock.position = { x: furnace.position.x + furnace.radius + 1, y: furnace.position.y };
    world.engine.processFurnaceDeliveries();
    expect(world.engine.getAsteroid(rock.id)).toBe(rock);
    expect(world.entity(alice).score).toBe(before);
    expect(world.engine.drainFurnaceDeliveries()).toEqual([]);

    rock.position.x = furnace.position.x + furnace.radius;
    world.engine.processFurnaceDeliveries();
    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    expect(world.entity(alice).score).toBe(before + points);
    const deliveries = world.engine.drainFurnaceDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      furnaceId: furnace.id,
      asteroidId: rock.id,
      rewards: [{ playerId: alice.id, points }],
    });
    world.engine.processFurnaceDeliveries();
    expect(world.engine.drainFurnaceDeliveries()).toEqual([]);
    expect(world.entity(alice).score).toBe(before + points);
  });

  test.each(['tow_cable', 'resource_tap'] as const)(
    'ignition invalidates a stale %s attachment before it can affect cargo',
    (utility) => {
      activate(alice);
      activate(alice);
      equip(bob, utility);
      world.entity(bob).harpoonTargetId = rock.id;
      world.entity(bob).harpoonLatchPos = { ...rock.position };
      world.entity(bob).tapExtractFrames = 999;
      const velocity = { ...rock.velocity };
      world.engine.abilities.advance();
      expect(world.entity(bob).harpoonTargetId).toBeNull();
      expect(rock.velocity).toEqual(velocity);
      expect(world.engine.getLoot()).toEqual([]);
    }
  );

  test('wire validation rejects malformed or unbounded burn state', () => {
    for (const boost of [
      { phase: 'armed', angle: 0 },
      { phase: 'burning', ownerId: alice.id, angle: Infinity },
      { phase: 'burning', angle: 0 },
      { phase: 'burning', ownerId: 42, angle: 0 },
      { phase: 'burning', ownerId: alice.id, angle: NaN },
    ]) {
      const candidate = { ...rock, boost };
      expect(() => validateAsteroidDto(candidate)).toThrow();
    }
  });
});
