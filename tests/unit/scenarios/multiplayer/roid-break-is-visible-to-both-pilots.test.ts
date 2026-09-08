import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ROID } from '../../../../src/constants';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A roid break is visible to both pilots', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice');
    bob = world.join('Bob');
  });

  afterEach(() => {
    world.dispose();
  });

  test('destroying a roid notifies every connected socket', () => {
    const roid = world.engine
      .createAsteroids(20)
      .find((asteroid) => !asteroid.isCollabTarget && asteroid.material === 'ice');
    expect(roid).toBeTruthy();

    alice.socket.clear();
    bob.socket.clear();
    const hit = (pilot: Pilot) => ({
      type: 'asteroidDestroyed',
      data: {
        asteroidId: roid!.id,
        playerId: pilot.id,
        points: ROID.POINTS_LARGE,
        cause: 'laser' as const,
        laserPosition: { x: roid!.position.x, y: roid!.position.y },
      },
    });
    world.engine.spawnLaser(alice.id, { ...roid!.position }, { x: 0, y: 0 });
    world.send(alice, hit(alice));
    world.engine.spawnLaser(bob.id, { ...roid!.position }, { x: 0, y: 0 });
    world.send(bob, hit(bob));

    for (const socket of [alice.socket, bob.socket]) {
      expect(socket.lastReceived('asteroidDestroy')?.data).toMatchObject({
        asteroidId: roid!.id,
      });
    }
    expect(world.engine.getAsteroid(roid!.id)).toBeUndefined();
  });
});
