import { afterEach, beforeEach, expect, test } from 'vitest';
import { radiusFromMass } from '../../../../shared/shipGrowth';
import { GAME, LASER } from '../../../../src/constants';
import { GameServerWorld, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();
let world: GameServerWorld;
beforeEach(() => {
  world = new GameServerWorld();
});
afterEach(() => world.dispose());

test.each([
  { mass: 1, normalSpeed: 1.125 },
  { mass: 8, normalSpeed: 0.675 },
])('Dart at mass $mass can report burst speed only during its ability', ({ mass, normalSpeed }) => {
  const pilot = world.join('Dart pilot', { x: 0, y: 0 }, { kitId: 'dart' });
  world.clearAsteroids();
  world.parkBots();
  const actor = world.entity(pilot);
  actor.mass = mass;
  actor.velocity = { x: normalSpeed, y: 0 };
  const burstSpeed = normalSpeed + 0.84375;
  actor.angle = 0;
  const now = world.engine.getServerTime();
  const pose = {
    epoch: actor.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { x: burstSpeed, y: 0 },
    velocity: { x: burstSpeed, y: 0 },
    angle: 0,
    thrusting: true,
  };
  expect(world.engine.playerMotion.acceptFreePose(pilot.socket, pose, now + 17).ok).toBe(false);
  world.send(pilot, {
    type: 'useAbility',
    id: pilot.id,
    data: { kitId: 'dart', abilityId: 'boostDash' },
  });
  expect(actor.abilityActiveFrames).toBe(12);
  expect(world.engine.playerMotion.acceptFreePose(pilot.socket, pose, now + 17).ok).toBe(true);
  expect(actor.velocity.x).toBeCloseTo(burstSpeed);
  const muzzle = { x: actor.position.x + (4 / 3) * radiusFromMass(mass), y: actor.position.y };
  const shotVelocity = { x: burstSpeed + LASER.SPEED / GAME.FPS, y: 0 };
  expect(world.engine.spawnHumanLaser(pilot.id, muzzle, shotVelocity, now + 17)).not.toBeNull();
  world.tick(12);
  expect(actor.abilityActiveFrames).toBe(0);
  expect(
    world.engine.playerMotion.acceptFreePose(pilot.socket, { ...pose, sequence: 2 }, now + 250).ok
  ).toBe(false);
  expect(
    world.engine.playerMotion.acceptFreePose(
      pilot.socket,
      {
        ...pose,
        sequence: 2,
        velocity: { x: normalSpeed, y: 0 },
      },
      now + 250
    ).ok
  ).toBe(true);
  expect(world.engine.spawnHumanLaser(pilot.id, muzzle, shotVelocity, now + 250)).toBeNull();
  expect(
    world.engine.spawnHumanLaser(
      pilot.id,
      muzzle,
      { x: normalSpeed + LASER.SPEED / GAME.FPS, y: 0 },
      now + 250
    )
  ).not.toBeNull();
});

test('a grown Hauler reports its reduced cruise speed and retains a server knockback grant', () => {
  const pilot = world.join('Grown Hauler', { x: 0, y: 0 }, { kitId: 'hauler' });
  world.clearAsteroids();
  world.parkBots();
  const actor = world.entity(pilot);
  actor.mass = 8;
  const now = world.engine.getServerTime();
  const pose = {
    epoch: actor.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { x: 0.984375, y: 0 },
    velocity: { x: 0.984375, y: 0 },
    angle: 0,
    thrusting: true,
  };
  expect(world.engine.playerMotion.acceptFreePose(pilot.socket, pose, now + 17).ok).toBe(false);
  expect(
    world.engine.playerMotion.acceptFreePose(
      pilot.socket,
      { ...pose, velocity: { x: 0.590625, y: 0 } },
      now + 17
    ).ok
  ).toBe(true);
  actor.velocity = { x: 0, y: 8 };
  world.engine.playerMotion.applyExternalImpulse(actor.id, now + 17);
  expect(
    world.engine.playerMotion.acceptFreePose(
      pilot.socket,
      {
        ...pose,
        epoch: actor.playerMotion?.epoch ?? 0,
        position: { x: 0.984375, y: 8 },
        velocity: { x: 0, y: 8 },
      },
      now + 34
    ).ok
  ).toBe(true);
});
