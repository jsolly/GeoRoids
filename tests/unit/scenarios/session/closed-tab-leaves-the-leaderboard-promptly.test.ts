import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A closed tab leaves the leaderboard promptly', () => {
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

  test('the departing pilot is gone from the board and the remaining pilot is told immediately', () => {
    expect(world.leaderboardNames()).toEqual(expect.arrayContaining(['Alice', 'Bob']));

    alice.socket.clear();
    world.disconnect(bob);

    expect(world.isOnServer(bob)).toBe(false);
    expect(world.leaderboardNames()).toContain('Alice');
    expect(world.leaderboardNames()).not.toContain('Bob');
    expect(alice.socket.lastReceived('playerLeft')?.data).toMatchObject({ id: bob.id });
  });
});
