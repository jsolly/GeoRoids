import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PLAYER_MOTION } from '../../../../shared/playerMotion';
import { GAME } from '../../../../src/constants';
import { SHIP_ABILITY } from '../../../../src/entities/ship/shipKits';
import { GameServerWorld, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();
let world: GameServerWorld;
beforeEach(() => {
  world = new GameServerWorld();
});
afterEach(() => world.dispose());

test('Quake throws an allied human outward and old movement packets cannot cancel the blast', () => {
  vi.spyOn(world.engine, 'getServerTime').mockReturnValue(world.engine.getServerTime());
  const caster = world.join('Quake', { x: 0, y: 0 }, { kitId: 'quake', factionId: 'ion' });
  const victim = world.join('Ally', { x: 100, y: 0 }, { factionId: 'ion' });
  world.clearAsteroids();
  world.parkBots();
  const actor = world.entity(victim);
  actor.velocity = { x: -10, y: 3 };
  const oldEpoch = actor.playerMotion?.epoch;
  world.send(caster, {
    type: 'useAbility',
    id: caster.id,
    data: { kitId: 'quake', abilityId: 'shockPulse' },
  });
  expect(actor.velocity.x).toBeGreaterThan(20);
  expect(actor.velocity.y).toBe(3);
  expect(actor.playerMotion?.epoch).toBe((oldEpoch ?? 0) + 1);
  const now = world.engine.getServerTime();
  const pose = {
    epoch: oldEpoch ?? 0,
    sequence: 100,
    position: { ...actor.position },
    velocity: { x: 0, y: 0 },
    angle: 0,
    thrusting: false,
  };
  expect(world.engine.playerMotion.acceptFreePose(victim.socket, pose, now).ok).toBe(false);
  const velocity = { ...actor.velocity };
  expect(
    world.engine.playerMotion.acceptFreePose(
      victim.socket,
      {
        ...pose,
        epoch: actor.playerMotion?.epoch ?? 0,
        velocity,
        position: { x: 100 + velocity.x, y: velocity.y },
      },
      now + 17
    ).ok
  ).toBe(true);
  expect(actor.velocity).toEqual(velocity);
  const midTime = now + 300;
  const midPose = {
    ...pose,
    epoch: actor.playerMotion?.epoch ?? 0,
    sequence: 101,
    position: { ...actor.position },
    velocity,
  };
  expect(world.engine.playerMotion.acceptFreePose(victim.socket, midPose, midTime).ok).toBe(false);
  const retained =
    PLAYER_MOTION.knockbackRetention ** ((300 * GAME.FPS) / 1000 - PLAYER_MOTION.poseLeadFrames);
  expect(
    world.engine.playerMotion.acceptFreePose(
      victim.socket,
      {
        ...midPose,
        velocity: { x: velocity.x * retained, y: velocity.y * retained },
      },
      midTime
    ).ok
  ).toBe(true);
  expect(
    world.engine.playerMotion.acceptFreePose(
      victim.socket,
      {
        ...pose,
        epoch: actor.playerMotion?.epoch ?? 0,
        sequence: 102,
        position: { ...actor.position },
        velocity,
      },
      now + 5000
    ).ok
  ).toBe(false);
  expect(world.entity(caster).velocity).toEqual({ x: 0, y: 0 });
});

test('an authenticated Quake blast dispatches to every authoritative physical body manager', () => {
  const caster = world.join('Quake', { x: 0, y: 0 }, { kitId: 'quake' });
  world.clearAsteroids();

  const loosePickup = world.engine.getAllSatellitePickups()[0];
  expect(loosePickup).toBeDefined();
  if (!loosePickup) {
    return;
  }
  const origin = { ...loosePickup.position };
  world.engine.updatePlayer(caster.id, { position: origin });
  world.engine.tickSatellitePickups();
  const pickupBefore = world.engine.getSatellitePickup(loosePickup.id);
  expect(pickupBefore?.state).toBe('orbiting');
  if (!pickupBefore) {
    return;
  }

  const asteroid = world.engine.getAsteroid('scenario-combat-buffer');
  expect(asteroid).toBeDefined();
  if (!asteroid) {
    return;
  }
  const lootPosition = { x: origin.x + 100, y: origin.y };
  world.engine.updateAsteroid(asteroid.id, { position: lootPosition });
  expect(world.engine.handleAsteroidHit(asteroid.id, caster.id, 'collision').outcome).toBe(
    'destroyed'
  );
  const lootBefore = world.engine.getLoot()[0];
  expect(lootBefore).toBeDefined();
  if (!lootBefore) {
    return;
  }

  const satelliteRows = world.engine.getAllSatellites();
  const selectedRow = satelliteRows[0];
  expect(selectedRow).toBeDefined();
  if (!selectedRow) {
    return;
  }
  for (const row of satelliteRows) {
    const satellite = world.engine.getSatellite(row.id);
    expect(satellite).toBeDefined();
    if (!satellite) {
      return;
    }
    const selected = row.id === selectedRow.id;
    const position = selected
      ? { x: origin.x + 100, y: origin.y }
      : { x: origin.x + SHIP_ABILITY.SHOCK_RADIUS + 1000, y: origin.y };
    satellite.position = { ...position };
    satellite.orbitCenter = { ...position };
    satellite.orbitRadiusX = 0;
    satellite.orbitRadiusY = 0;
    satellite.orbitPhase = 0;
    satellite.driftAngle = 0;
    satellite.velocity = { x: 0, y: 0 };
    satellite.shootCooldown = selected ? 0 : 1000;
    satellite.burstRemaining = 0;
    satellite.burstCooldown = selected ? 0 : 1000;
  }

  const playerShot = world.engine.spawnLaser(
    caster.id,
    { x: origin.x + 200, y: origin.y },
    { x: -10, y: 0 }
  );
  expect(playerShot).not.toBeNull();
  if (!playerShot) {
    return;
  }
  const playerVelocityBefore = { ...playerShot.velocity };
  const satelliteShots = world.engine.tickSatellites();
  expect(satelliteShots).toHaveLength(1);
  const satelliteProjectileBefore = world.engine
    .getActiveSatelliteProjectiles()
    .find((projectile) => projectile.satelliteId === selectedRow.id);
  expect(satelliteProjectileBefore).toBeDefined();
  if (!satelliteProjectileBefore) {
    return;
  }
  const selectedSatellite = world.engine.getSatellite(selectedRow.id);
  if (!selectedSatellite) {
    throw new Error('Missing configured satellite');
  }
  const satelliteVelocityBefore = { ...selectedSatellite.velocity };
  const pickupVelocityBefore = { ...pickupBefore.velocity };
  const fuelBefore = world.entity(caster).fuel;

  world.send(caster, {
    type: 'useAbility',
    id: caster.id,
    data: { kitId: 'quake', abilityId: 'shockPulse' },
  });

  expect(world.entity(caster).fuel).toBeLessThan(fuelBefore);
  const satelliteAfter = world.engine.getSatellite(selectedRow.id);
  expect(satelliteAfter?.velocity.x).toBeGreaterThan(satelliteVelocityBefore.x);
  const pickupAfter = world.engine.getSatellitePickup(loosePickup.id);
  expect(pickupAfter?.velocity.x).toBeGreaterThan(pickupVelocityBefore.x);
  const playerShotAfter = world.engine
    .getPlayerProjectiles()
    .find((projectile) => projectile.id === playerShot.id);
  expect(playerShotAfter?.velocity.x).toBeGreaterThan(playerVelocityBefore.x);
  const satelliteProjectileAfter = world.engine
    .getActiveSatelliteProjectiles()
    .find((projectile) => projectile.shotId === satelliteProjectileBefore.shotId);
  expect(satelliteProjectileAfter?.velocity.x).toBeGreaterThan(
    satelliteProjectileBefore.velocity.x
  );

  world.engine.advanceOneFrame();
  const lootAfter = world.engine.getLoot().find((loot) => loot.id === lootBefore.id);
  expect(lootAfter?.position.x).toBeGreaterThan(lootBefore.position.x);
});

test('a blasted pilot can fire with real knockback carry only while its server grant lasts', () => {
  const caster = world.join('Quake', { x: 0, y: 0 }, { kitId: 'quake' });
  const victim = world.join('Pilot', { x: 100, y: 0 });
  world.clearAsteroids();
  world.parkBots();
  world.send(caster, {
    type: 'useAbility',
    id: caster.id,
    data: { kitId: 'quake', abilityId: 'shockPulse' },
  });
  const actor = world.entity(victim);
  const now = world.engine.getServerTime();
  expect(actor.velocity.x).toBeGreaterThan(20);
  const muzzle = { x: actor.position.x + 20, y: actor.position.y };
  const velocity = { x: actor.velocity.x + 5, y: actor.velocity.y };
  expect(world.engine.spawnHumanLaser(victim.id, muzzle, velocity, now)).not.toBeNull();
  expect(world.engine.spawnHumanLaser(victim.id, muzzle, velocity, now + 5000)).toBeNull();
});

test('Quake turns incoming player shots outward without changing their owner', () => {
  const caster = world.join('Quake', { x: 0, y: 0 }, { kitId: 'quake' });
  const shooter = world.join('Shooter', { x: 300, y: 0 });
  world.clearAsteroids();
  world.parkBots();
  const shot = world.engine.spawnLaser(shooter.id, { x: 100, y: 0 }, { x: -10, y: 2 });
  expect(shot).not.toBeNull();
  world.send(caster, {
    type: 'useAbility',
    id: caster.id,
    data: { kitId: 'quake', abilityId: 'shockPulse' },
  });
  const published = world.engine
    .getPlayerProjectiles()
    .find((candidate) => candidate.id === shot?.id);
  expect(published?.ownerId).toBe(shooter.id);
  expect(published?.velocity.x).toBeGreaterThan(20);
  expect(published?.velocity.y).toBe(2);
});

test('Quake sends a bot flying faster than its normal steering cap', () => {
  world.engine.createBots();
  const caster = world.join('Quake', { x: 0, y: 0 }, { kitId: 'quake' });
  world.clearAsteroids();
  world.parkBots();
  const bot = world.engine.entityManager.getBots()[0];
  expect(bot).toBeDefined();
  if (!bot) {
    throw new Error('Missing default bot');
  }
  bot.position = { x: 100, y: 0 };
  bot.velocity = { x: 0, y: 0 };
  world.send(caster, {
    type: 'useAbility',
    id: caster.id,
    data: { kitId: 'quake', abilityId: 'shockPulse' },
  });
  world.engine.entityManager.updateBotMovement();
  expect(bot.position.x).toBeGreaterThan(130);
  expect(Math.hypot(bot.velocity.x, bot.velocity.y)).toBeGreaterThan(10);
});
