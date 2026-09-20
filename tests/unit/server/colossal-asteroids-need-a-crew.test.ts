/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { furnaceHeading } from '../../../shared/asteroidBoost';
import {
  applyColossalDeposit,
  asteroidCrewNeeded,
  colossalMiningHealth,
  isColossalAsteroid,
  sectorHostsColossal,
} from '../../../shared/asteroidScale';
import { WORLD } from '../../../shared/world';
import type { AsteroidData, HaulerUtilityId } from '../../../shared-types';
import { DAMAGE, ROID } from '../../../src/constants';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import {
  GameServerWorld,
  type Pilot,
  useQuietServerConsole,
} from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

function colossalRock(id: string, position = { x: 0, y: 0 }): AsteroidData {
  const rock: AsteroidData = {
    id,
    position: { ...position },
    velocity: { x: 0.4, y: 0 },
    size: 40,
    jaggedness: 0.25,
    rotation: 0,
    angularVelocity: 0,
    health: 25,
    maxHealth: 25,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    material: 'ice',
  };
  applyColossalDeposit(rock);
  return rock;
}

function findHostedSector(seed: number): { x: number; y: number } {
  for (let y = -8; y <= 8; y++) {
    for (let x = -8; x <= 8; x++) {
      if (sectorHostsColossal(x, y, seed)) {
        return { x, y };
      }
    }
  }
  throw new Error('No colossal host sector in the sample window');
}

describe('Colossal asteroids need a crew', () => {
  let world: GameServerWorld;

  afterEach(() => {
    world?.dispose();
  });

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

  test('the launch neighborhood stays free of colossal deposits and crew size follows rock scale', () => {
    expect(isColossalAsteroid(ROID.COLOSSAL_MIN_SIZE - 1)).toBe(false);
    expect(isColossalAsteroid(ROID.COLOSSAL_MIN_SIZE)).toBe(true);
    expect(isColossalAsteroid(ROID.COLOSSAL_SIZE)).toBe(true);
    expect(asteroidCrewNeeded(40)).toBe(1);
    expect(asteroidCrewNeeded(ROID.COLOSSAL_SIZE)).toBe(ROID.COLOSSAL_CREW);
    expect(colossalMiningHealth()).toBe(DAMAGE.LASER_HIT * ROID.COLOSSAL_LASER_HITS);
    expect(sectorHostsColossal(0, 0, 82)).toBe(false);
    expect(sectorHostsColossal(1, -1, 82)).toBe(false);
  });

  test('fresh non-core sectors host one stationary colossal deposit without adding a slot', () => {
    const seed = 82;
    const hosted = findHostedSector(seed);
    const field = new RegionalAsteroidField(seed);
    const manager = new AsteroidManager(new RNGService(seed));
    const observer = {
      x: (hosted.x + 0.5) * WORLD.sectorSize,
      y: (hosted.y + 0.5) * WORLD.sectorSize,
    };
    field.update(manager, [observer], new Set());
    const rocks = manager
      .getAllAsteroids()
      .filter((rock) => rock.id.startsWith(`deposit-${seed}-${hosted.x}-${hosted.y}-`));
    const colossal = rocks.filter((rock) => isColossalAsteroid(rock.size));
    expect(rocks).toHaveLength(WORLD.depositsPerSector);
    expect(colossal).toHaveLength(1);
    expect(colossal[0]?.id).toMatch(
      new RegExp(`^deposit-${seed}-${hosted.x}-${hosted.y}-\\d+$`, 'u')
    );
    expect(colossal[0]?.size).toBe(ROID.COLOSSAL_SIZE);
    expect(colossal[0]?.health).toBe(colossalMiningHealth());
    expect(colossal[0]?.velocity).toEqual({ x: 0, y: 0 });
    expect(colossal[0]?.isCollabTarget).toBeUndefined();
    expect(colossal[0]?.phenomenon).toBeUndefined();
    expect(sectorHostsColossal(0, 0, seed)).toBe(false);
  });

  test('one Tow Cable holds a colossal deposit; two haul it', () => {
    world = new GameServerWorld();
    const alice = world.join('Alice', { x: -40, y: 0 }, { kitId: 'hauler' });
    const bob = world.join('Bob', { x: 40, y: 0 }, { kitId: 'hauler' });
    world.clearAsteroids();
    const rock = colossalRock('colossal-tow', { x: 0, y: 0 });
    world.engine.addAsteroid(rock);
    equip(alice, 'tow_cable');
    equip(bob, 'tow_cable');
    activate(alice);
    expect(world.entity(alice).harpoonTargetId).toBe(rock.id);
    world.engine.updatePlayer(alice.id, { position: { x: -400, y: 0 } });
    world.tick();
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
    activate(bob);
    expect(world.entity(bob).harpoonTargetId).toBe(rock.id);
    world.engine.updatePlayer(alice.id, { position: { x: -400, y: 0 } });
    world.tick();
    expect(rock.velocity.x).toBeLessThan(0);
  });

  test('one Boost Coupling cannot ignite a colossal deposit; two launch and both are paid', () => {
    world = new GameServerWorld();
    const alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    const bob = world.join('Bob', { x: 0, y: 80 }, { kitId: 'hauler' });
    world.clearAsteroids();
    const rock = colossalRock('colossal-boost', { x: 150, y: 0 });
    world.engine.addAsteroid(rock);
    world.entity(alice).angle = 0;
    world.entity(bob).angle = 0;
    equip(alice, 'boost_coupling');
    equip(bob, 'boost_coupling');
    activate(alice);
    expect(rock.boost).toEqual({
      phase: 'armed',
      ownerId: alice.id,
      angle: furnaceHeading(rock.position),
    });
    activate(alice);
    expect(rock.boost?.phase).toBe('armed');
    expect(world.entity(alice).harpoonTargetId).toBe(rock.id);
    activate(bob);
    expect(boostCrew(rock)).toEqual([alice.id, bob.id]);
    activate(alice);
    expect(rock.boost?.phase).toBe('burning');
    expect(rock.boost?.couplings).toEqual([alice.id, bob.id]);
    expect(world.entity(alice).harpoonTargetId).toBeNull();
    expect(world.entity(bob).harpoonTargetId).toBeNull();
    rock.position = { x: 0, y: -660 };
    world.engine.processFurnaceDeliveries();
    const deliveries = world.engine.drainFurnaceDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.rewards.map((reward) => reward.playerId).sort()).toEqual(
      [alice.id, bob.id].sort()
    );
  });

  test('a Surveyor needs many laser hits to fragment a colossal deposit', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    for (const existing of engine.getAllAsteroids()) {
      engine.removeAsteroid(existing.id);
    }
    const rock = colossalRock('colossal-mine', { x: 400, y: 300 });
    engine.addAsteroid(rock);
    const hits = ROID.COLOSSAL_LASER_HITS;
    for (let shot = 0; shot < hits - 1; shot++) {
      const tagged = engine.applyLaserAsteroidHit(rock.id, 'p1');
      expect(tagged.outcome).toBe('tagged');
      expect(engine.getAsteroid(rock.id)).toBeDefined();
    }
    engine.flushExpiredCollabHits(Date.now() + ROID.COLLAB_SPLIT_WINDOW_MS + 1);
    expect(engine.getAsteroid(rock.id)).toBeDefined();
    const last = engine.applyLaserAsteroidHit(rock.id, 'p1');
    expect(last.outcome).toBe('destroyed');
    expect(last.split).toBe(false);
    expect(last.newAsteroids).toHaveLength(2);
    expect(last.newAsteroids.every((fragment) => !isColossalAsteroid(fragment.size))).toBe(true);
    expect(last.newAsteroids[0]?.size).toBe(ROID.COLOSSAL_SIZE * 0.5);
    expect(last.newAsteroids[1]?.size).toBe(ROID.COLOSSAL_SIZE * 0.5);
    expect(engine.getPlayer('p1')?.score).toBe(ROID.POINTS_COLOSSAL);
  });

  test('a Hauler fragments a colossal deposit in half as many hits', () => {
    const engine = new GameEngine();
    engine.addPlayer('h1', 'Haul', {} as never, { x: 0, y: 0 }, 'hauler');
    for (const existing of engine.getAllAsteroids()) {
      engine.removeAsteroid(existing.id);
    }
    const rock = colossalRock('colossal-hauler-mine', { x: 400, y: 300 });
    engine.addAsteroid(rock);
    const hits = ROID.COLOSSAL_LASER_HITS / SHIP_ABILITY.ASTEROID_DAMAGE_MULTIPLIER;
    for (let shot = 0; shot < hits - 1; shot++) {
      expect(engine.applyLaserAsteroidHit(rock.id, 'h1').outcome).toBe('tagged');
    }
    expect(engine.applyLaserAsteroidHit(rock.id, 'h1').outcome).toBe('destroyed');
  });

  test('ramming a colossal deposit damages the ship and leaves the rock', () => {
    world = new GameServerWorld();
    const alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'surveyor' });
    world.clearAsteroids();
    const rock = colossalRock('colossal-ram', { x: 0, y: 0 });
    world.engine.addAsteroid(rock);
    world.engine.entityManager.updateEntity(alice.id, { spawnProtectionTimer: 0 });
    const actor = world.entity(alice);
    const healthBefore = actor.health;
    const overlap = { ...actor.position };
    const epoch = actor.playerMotion?.epoch ?? 0;
    world.engine.resolveAuthoritativeCombat();
    expect(world.engine.getAsteroid(rock.id)).toBeDefined();
    expect(world.entity(alice).health).toBe(healthBefore - DAMAGE.ASTEROID_COLLISION);
    const distance = Math.hypot(
      world.entity(alice).position.x - rock.position.x,
      world.entity(alice).position.y - rock.position.y
    );
    expect(distance).toBeGreaterThan(rock.size);
    expect(world.entity(alice).playerMotion?.epoch).toBe(epoch + 1);
    const now = world.engine.getServerTime();
    expect(
      world.engine.playerMotion.acceptFreePose(
        alice.socket,
        {
          epoch,
          sequence: 1,
          position: overlap,
          velocity: { x: 0, y: 0 },
          angle: 0,
          thrusting: false,
        },
        now + 17
      ).ok
    ).toBe(false);
    const healthAfter = world.entity(alice).health;
    world.engine.resolveAuthoritativeCombat();
    expect(world.entity(alice).health).toBe(healthAfter);
    expect(world.engine.getAsteroid(rock.id)).toBeDefined();
  });

  test('towing a colossal deposit into another rock breaks the other rock only', () => {
    world = new GameServerWorld();
    const alice = world.join('Alice', { x: 140, y: 0 }, { kitId: 'hauler' });
    const bob = world.join('Bob', { x: 40, y: 0 }, { kitId: 'hauler' });
    world.clearAsteroids();
    const rock = colossalRock('colossal-bumper', { x: 80, y: 0 });
    world.engine.addAsteroid(rock);
    world.engine.addAsteroid({
      id: 'field-rock',
      position: { x: 155, y: 0 },
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
    equip(alice, 'tow_cable');
    equip(bob, 'tow_cable');
    activate(alice);
    activate(bob);
    expect(world.entity(alice).harpoonTargetId).toBe(rock.id);
    expect(world.entity(bob).harpoonTargetId).toBe(rock.id);
    world.engine.entityManager.updateEntity(alice.id, { spawnProtectionTimer: 0 });
    world.engine.entityManager.updateEntity(bob.id, { spawnProtectionTimer: 0 });
    const healthBefore = world.entity(alice).health;
    world.engine.resolveAuthoritativeCombat();
    expect(world.entity(alice).health).toBe(healthBefore);
    expect(world.entity(alice).harpoonTargetId).toBe(rock.id);
    expect(world.engine.getAsteroid(rock.id)).toBeDefined();
    expect(world.engine.getAsteroid('field-rock')).toBeUndefined();
  });
});

function boostCrew(rock: AsteroidData): string[] {
  return rock.boost?.couplings ?? (rock.boost ? [rock.boost.ownerId] : []);
}
