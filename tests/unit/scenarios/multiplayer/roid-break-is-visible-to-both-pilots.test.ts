import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A roid break is visible to both pilots', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice');
    bob = world.join('Bob', { x: 120, y: 0 });
  });

  afterEach(() => {
    world.dispose();
  });

  test('destroying a roid notifies every connected socket', () => {
    const roid = world.engine
      .createAsteroids(20)
      .find(
        (asteroid) =>
          !asteroid.isCollabTarget &&
          asteroid.material === 'metal' &&
          asteroid.phenomenon === undefined
      );
    assert.ok(roid);
    roid.health = 50;
    roid.maxHealth = 50;

    alice.socket.clear();
    bob.socket.clear();
    world.shootAsteroid(alice, roid.id);
    world.shootAsteroid(bob, roid.id);

    for (const socket of [alice.socket, bob.socket]) {
      expect(socket.lastReceived('asteroidDestroy')?.data).toMatchObject({
        asteroidId: roid.id,
      });
    }
    expect(world.engine.getAsteroid(roid.id)).toBeUndefined();
  });
});
