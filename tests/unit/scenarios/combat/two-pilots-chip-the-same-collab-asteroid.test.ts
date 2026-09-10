import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DAMAGE } from '../../../../src/constants';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('Two pilots chip the same collab asteroid', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice', { x: -80, y: 0 });
    bob = world.join('Bob', { x: 80, y: 0 });
  });

  afterEach(() => {
    world.dispose();
  });

  test('each laser subtracts from the shared rock and it stays up', () => {
    const [roid] = world.engine.createAsteroids(1);
    assert.ok(roid);
    expect(roid.isCollabTarget).toBe(true);
    const startHealth = roid.health;
    expect(startHealth).toBe(100);

    world.shootAsteroid(alice, roid.id);
    expect(world.engine.getAsteroid(roid.id)?.health).toBe(startHealth - DAMAGE.LASER_HIT);
    expect(world.engine.getAsteroid(roid.id)).toBeTruthy();

    const firstHitHealth = world.engine.getAsteroid(roid.id)?.health;
    assert.ok(firstHitHealth);
    world.shootAsteroid(bob, roid.id);
    expect(world.engine.getAsteroid(roid.id)?.health).toBe(firstHitHealth - DAMAGE.LASER_HIT);
    expect(world.engine.getAsteroid(roid.id)).toBeTruthy();
  });
});
