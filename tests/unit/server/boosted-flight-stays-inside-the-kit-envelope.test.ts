import { afterEach, beforeEach, expect, test } from 'vitest';
import { cruiseSpeed } from '../../../shared/shipFlight';
import { Ship } from '../../../src/entities/ship/Ship';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { sampleGradient } from '../../../src/physics/terrain/heightfield';
import { getTerrainField } from '../../../src/physics/terrain/terrainSession';
import { RecordingSocket } from '../../support/recordingSocket';
import {
  EXPLOSION_FRAMES,
  GameServerWorld,
  useQuietServerConsole,
} from '../scenarios/support/gameServerWorld';

useQuietServerConsole();
let world: GameServerWorld;
beforeEach(() => {
  world = new GameServerWorld();
});
afterEach(() => world.dispose());

test('a boosting Scout may cruise faster than a boosting Hauler, and overspeed is rejected', () => {
  const scoutPilot = world.join('Boost Scout', { x: 0, y: 0 }, { kitId: 'scout' });
  const haulerPilot = world.join('Boost Hauler', { x: 40, y: 0 }, { kitId: 'hauler' });
  world.clearAsteroids();
  const scout = world.entity(scoutPilot);
  const hauler = world.entity(haulerPilot);
  const now = world.engine.getServerTime();
  const scoutKit = getShipKit('scout');
  const haulerKit = getShipKit('hauler');
  const scoutBoost = cruiseSpeed(scout.mass, scoutKit.maxVelocity, scoutKit.boostMultiplier);
  const haulerBoost = cruiseSpeed(hauler.mass, haulerKit.maxVelocity, haulerKit.boostMultiplier);
  expect(scoutBoost).toBeGreaterThan(haulerBoost);
  expect(scoutKit.maxVelocity).toBe(haulerKit.maxVelocity);

  const scoutPose = {
    epoch: scout.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { x: scoutBoost, y: 0 },
    velocity: { x: scoutBoost, y: 0 },
    angle: 0,
    thrusting: true,
    boosting: true,
  };
  expect(world.engine.playerMotion.acceptFreePose(scoutPilot.socket, scoutPose, now + 17).ok).toBe(
    true
  );

  const haulerPose = {
    epoch: hauler.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { x: 40 + haulerBoost, y: 0 },
    velocity: { x: haulerBoost, y: 0 },
    angle: 0,
    thrusting: true,
    boosting: true,
  };
  expect(
    world.engine.playerMotion.acceptFreePose(haulerPilot.socket, haulerPose, now + 17).ok
  ).toBe(true);

  expect(
    world.engine.playerMotion.acceptFreePose(
      haulerPilot.socket,
      {
        ...haulerPose,
        epoch: hauler.playerMotion?.epoch ?? 0,
        sequence: 2,
        position: { x: 40 + scoutBoost, y: 0 },
        velocity: { x: scoutBoost, y: 0 },
      },
      now + 34
    ).ok
  ).toBe(false);
});

test('a pilot must release and reactivate boost but can spend a partially recharged tank', () => {
  const pilot = world.join('Burst', { x: 0, y: 0 }, { kitId: 'scout' });
  const actor = world.entity(pilot);
  const motion = world.engine.playerMotion;
  const now = world.engine.getServerTime();
  let sequence = 0;
  const pose = (at: number, boosting: boolean, speed = 0) =>
    motion.acceptFreePose(
      pilot.socket,
      {
        epoch: actor.playerMotion?.epoch ?? 0,
        sequence: ++sequence,
        position: { ...actor.position },
        velocity: { x: speed, y: 0 },
        angle: 0,
        thrusting: true,
        boosting,
      },
      now + at
    );
  expect(pose(0, true).ok).toBe(true);
  expect(pose(1500, true).ok).toBe(true);
  expect(actor.boost.charge).toBeCloseTo(0.5);
  expect(pose(3000, true).ok).toBe(true);
  expect(actor.boost).toEqual({ phase: 'exhausted', charge: 0 });
  // A held request cannot automatically restart after depletion.
  expect(pose(4000, true).ok).toBe(true);
  expect(actor.boost).toEqual({ phase: 'exhausted', charge: 0.2 });
  expect(pose(4000, false).ok).toBe(true);
  expect(pose(4000, true).ok).toBe(true);
  expect(actor.boost).toEqual({ phase: 'active', charge: 0.2 });
  expect(pose(4300, true).ok).toBe(true);
  expect(actor.boost.charge).toBeCloseTo(0.1);
  expect(pose(4600, true).ok).toBe(true);
  expect(actor.boost).toEqual({ phase: 'exhausted', charge: 0 });
  const kit = getShipKit(actor.kitId);
  expect(pose(4600, true, cruiseSpeed(actor.mass, kit.maxVelocity, kit.boostMultiplier)).ok).toBe(
    false
  );
  expect(pose(9600, true).ok).toBe(true);
  expect(actor.boost).toEqual({ phase: 'idle', charge: 1 });
  expect(pose(9600, false).ok).toBe(true);
  expect(pose(9600, true).ok).toBe(true);
  expect(actor.boost.phase).toBe('active');
});

test('boost expires without incoming poses and reconnect preserves the remaining tank', () => {
  const pilot = world.join('Reconnect burst', { x: 0, y: 0 });
  const actor = world.entity(pilot);
  const motion = world.engine.playerMotion;
  const now = world.engine.getServerTime();
  expect(
    motion.acceptFreePose(
      pilot.socket,
      {
        epoch: actor.playerMotion?.epoch ?? 0,
        sequence: 1,
        position: { ...actor.position },
        velocity: { x: 0, y: 0 },
        angle: 0,
        thrusting: true,
        boosting: true,
      },
      now
    ).ok
  ).toBe(true);
  motion.step(now + 3000);
  expect(actor.boost).toEqual({ phase: 'exhausted', charge: 0 });
  motion.transportClosed(pilot.socket, now + 3000);
  const resumed = motion.resume(pilot.resumeToken, new RecordingSocket(), now + 3500);
  expect(resumed.ok).toBe(true);
  expect(actor.boost).toEqual({ phase: 'exhausted', charge: 0.1 });
});

test('a predicted-empty pose spends the last fraction and starts recharge without adding energy', () => {
  const pilot = world.join('Predicted empty', { x: 0, y: 0 });
  const actor = world.entity(pilot);
  const now = world.engine.getServerTime();
  const pose = {
    epoch: actor.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { ...actor.position },
    velocity: { x: 0, y: 0 },
    angle: 0,
    thrusting: true,
    boosting: true,
  };
  expect(world.engine.playerMotion.acceptFreePose(pilot.socket, pose, now).ok).toBe(true);
  expect(
    world.engine.playerMotion.acceptFreePose(
      pilot.socket,
      { ...pose, sequence: 2, boosting: false, boostDepleted: true },
      now + 2980
    ).ok
  ).toBe(true);
  expect(actor.boost).toEqual({ phase: 'exhausted', charge: 0 });
  expect(
    world.engine.playerMotion.acceptFreePose(
      pilot.socket,
      { ...pose, sequence: 3, boosting: false, boostDepleted: true },
      now + 3980
    ).ok
  ).toBe(true);
  expect(actor.boost).toEqual({ phase: 'exhausted', charge: 0.2 });
});

test('disconnect and handoff remove boosted velocity without refilling the tank', () => {
  const pilot = world.join('Disconnect speed', { x: 0, y: 0 }, { kitId: 'scout' });
  const actor = world.entity(pilot);
  const motion = world.engine.playerMotion;
  const now = world.engine.getServerTime();
  const kit = getShipKit(actor.kitId);
  const speed = cruiseSpeed(actor.mass, kit.maxVelocity, kit.boostMultiplier);
  expect(
    motion.acceptFreePose(
      pilot.socket,
      {
        epoch: actor.playerMotion?.epoch ?? 0,
        sequence: 1,
        position: { ...actor.position },
        velocity: { x: speed, y: 0 },
        angle: 0,
        thrusting: true,
        boosting: true,
      },
      now
    ).ok
  ).toBe(true);
  motion.transportClosed(pilot.socket, now + 1500);
  expect(actor.boost).toEqual({ phase: 'idle', charge: 0.5 });
  expect(Math.hypot(actor.velocity.x, actor.velocity.y)).toBeLessThanOrEqual(
    motion.legalSpeed(actor, now + 1500)
  );
  const resumed = motion.resume(pilot.resumeToken, new RecordingSocket(), now + 2000);
  expect(resumed.ok).toBe(true);
  expect(actor.boost).toEqual({ phase: 'idle', charge: 0.6 });
  expect(Math.hypot(actor.velocity.x, actor.velocity.y)).toBeLessThanOrEqual(
    motion.legalSpeed(actor, now + 2000)
  );
});

test('a pilot can restart partial boost after a motion correction resets the epoch', () => {
  const pilot = world.join('Corrected boost', { x: 0, y: 0 }, { kitId: 'scout' });
  const actor = world.entity(pilot);
  const motion = world.engine.playerMotion;
  const now = world.engine.getServerTime();
  const pose = {
    epoch: actor.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { ...actor.position },
    velocity: { x: 0, y: 0 },
    angle: 0,
    thrusting: true,
    boosting: true,
  };
  expect(motion.acceptFreePose(pilot.socket, pose, now).ok).toBe(true);
  expect(
    motion.acceptFreePose(
      pilot.socket,
      { ...pose, sequence: 2, velocity: { x: 999, y: 0 } },
      now + 1500
    ).ok
  ).toBe(false);
  expect(actor.playerMotion?.mode).toBe('handoff');
  expect(actor.boost).toEqual({ phase: 'idle', charge: 0.5 });
  expect(
    motion.acceptFreePose(
      pilot.socket,
      { ...pose, epoch: actor.playerMotion?.epoch ?? 0, sequence: 0 },
      now + 1500
    ).ok
  ).toBe(true);
  expect(actor.boost).toEqual({ phase: 'active', charge: 0.5 });
});

test('a pilot can boost immediately after dying during a burst and respawning', () => {
  const pilot = world.join('Respawn burst', { x: 0, y: 0 });
  const actor = world.entity(pilot);
  const motion = world.engine.playerMotion;
  const pose = () => ({
    epoch: actor.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { ...actor.position },
    velocity: { x: 0, y: 0 },
    angle: 0,
    thrusting: true,
    boosting: true,
  });
  expect(motion.acceptFreePose(pilot.socket, pose(), world.engine.getServerTime()).ok).toBe(true);
  expect(actor.boost.phase).toBe('active');
  actor.spawnProtectionTimer = 0;
  actor.health = 1;
  world.hitAsteroid(pilot);
  expect(actor.exploding).toBe(true);
  world.clearAsteroids();
  world.tick(EXPLOSION_FRAMES);
  motion.step(world.engine.getServerTime());
  expect(actor.exploding).toBe(false);
  expect(actor.boost).toEqual({ phase: 'idle', charge: 1 });
  expect(motion.acceptFreePose(pilot.socket, pose(), world.engine.getServerTime()).ok).toBe(true);
  expect(actor.boost.phase).toBe('active');
});

test.each(['scout', 'hauler'] as const)(
  '%s reports contour speed, fires, and turns across contours without server corrections',
  (kitId) => {
    const pilot = world.join('Contour pilot', { x: 2250, y: 0 }, { kitId });
    const actor = world.entity(pilot);
    world.clearAsteroids();
    const ship = new Ship({ kitId, position: { ...actor.position }, isLocalPlayer: true });
    const gradient = sampleGradient(getTerrainField(), ship.position.x, ship.position.y);
    ship.angle = Math.atan2(-gradient.x, -gradient.y);
    const now = world.engine.getServerTime();
    let fastest = 0;
    for (let frame = 1; frame <= 480; frame++) {
      if (frame % 120 === 0) {
        ship.angle += Math.PI / 2;
      }
      ship.update();
      ship.angle = Math.atan2(Math.sin(ship.angle), Math.cos(ship.angle));
      fastest = Math.max(fastest, Math.hypot(ship.velocity.x, ship.velocity.y));
      const outcome = world.engine.playerMotion.acceptFreePose(
        pilot.socket,
        {
          epoch: actor.playerMotion?.epoch ?? 0,
          sequence: frame,
          position: { ...ship.position },
          velocity: { ...ship.velocity },
          angle: ship.angle,
          thrusting: true,
        },
        now + (frame * 1000) / 60
      );
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (frame % 30 === 0) {
        const laser = ship.generateLaser();
        expect(
          world.engine.spawnPlayerLaser(
            actor.id,
            laser.position,
            laser.velocity,
            now + (frame * 1000) / 60
          )
        ).not.toBeNull();
      }
    }
    expect(fastest).toBeGreaterThan(getShipKit(kitId).maxVelocity * 1.1);
  }
);
