import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { RNGService } from '../../../server/core/RNGService';
import { ASTEROID_BOOST, furnaceHeading } from '../../../shared/asteroidBoost';
import { furnaceReward, nearestFurnace } from '../../../shared/furnaces';
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

  test('arming aims at the furnace; ignition survives departure and rewards its owner exactly once', () => {
    activate(alice);
    step(5);
    expect(rock.boost).toEqual({
      phase: 'armed',
      ownerId: alice.id,
      angle: furnaceHeading(rock.position),
    });
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
    expect(rock.position).toEqual({ x: 150, y: 0 });
    expect(snapshotRock(bob).boost).toEqual(rock.boost);
    world.entity(alice).angle = Math.PI / 2;
    activate(alice);
    expect(world.entity(alice).harpoonTargetId).toBeNull();
    expect(world.entity(alice).abilityCooldownFrames).toBe(180);
    expect(rock.boost).toEqual({
      phase: 'burning',
      ownerId: alice.id,
      angle: furnaceHeading(rock.position),
    });
    const destination = nearestFurnace(rock.position);
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
    expect(Math.hypot(rock.velocity.x, rock.velocity.y)).toBeCloseTo(ASTEROID_BOOST.acceleration);
    expect(local.velocity).toEqual(rock.velocity);
    expect(local.boost).toEqual(rock.boost);
    expect(bobView.boost).toEqual({
      phase: 'burning',
      ownerId: alice.id,
      angle: furnaceHeading(rock.position),
    });
    step(179);
    expect(rock.boost?.phase).toBe('burning');
    for (let frame = 0; frame < 1000 && world.engine.getAsteroid(rock.id); frame++) {
      step(1);
    }
    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    const deliveries = world.engine.drainFurnaceDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.furnaceId).toBe(destination.id);
    expect(deliveries[0]?.rewards).toEqual([
      expect.objectContaining({ playerId: alice.id, points: furnaceReward(rock) }),
    ]);
    world.engine.processFurnaceDeliveries();
    expect(world.engine.drainFurnaceDeliveries()).toEqual([]);
    const resumed = world.resume(alice, { x: 0, y: 0 });
    expect(world.entity(resumed).score).toBe(furnaceReward(rock));
  });

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

  test('weapons, direct mining, shockwaves, and new scans cannot affect ignited cargo', () => {
    activate(alice);
    activate(alice);
    rock.isCollabTarget = true;
    const original = structuredClone(rock);
    expect(world.engine.applyLaserAsteroidHit(rock.id, bob.id).outcome).toBe('ignored');
    expect(world.engine.handleAsteroidDamage(rock.id, bob.id).destroyed).toBe(false);
    const manager = new AsteroidManager(new RNGService(42));
    manager.addAsteroid(rock);
    expect(manager.applyRadialImpulse({ x: 140, y: 0 }, 300, 10)).toBe(0);
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

  test('a mining tag from before ignition cannot destroy self-guided cargo when it expires', () => {
    rock.material = 'ice';
    rock.size = 50;
    const hitAt = world.engine.getServerTime();
    expect(world.engine.applyLaserAsteroidHit(rock.id, bob.id, 'laser', hitAt).outcome).toBe(
      'tagged'
    );
    activate(alice);
    activate(alice);
    expect(rock.boost?.phase).toBe('burning');
    world.engine.flushExpiredCollabHits(hitAt + 10000);
    expect(world.engine.getAsteroid(rock.id)).toBe(rock);
    expect(world.engine.getLoot()).toEqual([]);
  });

  test('delivery still pays its original launcher after the launcher loses the last life', () => {
    activate(alice);
    activate(alice);
    world.entity(alice).lives = 0;
    rock.position = { ...nearestFurnace(rock.position).position };
    world.engine.processFurnaceDeliveries();
    expect(world.entity(alice).score).toBe(furnaceReward(rock));
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
      world.engine.tickAbilities();
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
