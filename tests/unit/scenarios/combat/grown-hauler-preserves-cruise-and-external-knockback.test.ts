import { afterEach, beforeEach, expect, test } from 'vitest';
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
