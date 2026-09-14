import { afterEach, beforeEach, expect, test } from 'vitest';
import { cruiseSpeed } from '../../../../shared/shipFlight';
import { getShipKit } from '../../../../src/entities/ship/shipKits';
import { GameServerWorld, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();
let world: GameServerWorld;
beforeEach(() => {
  world = new GameServerWorld();
});
afterEach(() => world.dispose());

test('a grown Hauler reports its reduced cruise speed and retains a server knockback grant', () => {
  const pilot = world.join('Grown Hauler', { x: 0, y: 0 }, { kitId: 'hauler' });
  world.clearAsteroids();
  const actor = world.entity(pilot);
  actor.mass = 8;
  const now = world.engine.getServerTime();
  const kit = getShipKit('hauler');
  const grownCruise = cruiseSpeed(8, kit.maxVelocity);
  const pose = {
    epoch: actor.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { x: kit.maxVelocity, y: 0 },
    velocity: { x: kit.maxVelocity, y: 0 },
    angle: 0,
    thrusting: true,
  };
  expect(world.engine.playerMotion.acceptFreePose(pilot.socket, pose, now + 17).ok).toBe(false);
  expect(
    world.engine.playerMotion.acceptFreePose(
      pilot.socket,
      { ...pose, velocity: { x: grownCruise, y: 0 } },
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
        position: { x: kit.maxVelocity, y: 8 },
        velocity: { x: 0, y: 8 },
      },
      now + 34
    ).ok
  ).toBe(true);
});
