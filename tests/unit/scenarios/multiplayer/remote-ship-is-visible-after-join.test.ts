import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A remote ship is visible after join', () => {
  let world: GameServerWorld;
  let alice: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice', { x: -40, y: 0 });
    alice.socket.clear();
  });

  afterEach(() => {
    world.dispose();
  });

  test('the first pilot is told when the second ship appears, and both are in the snapshot', () => {
    const bob = world.join('Bob', { x: 40, y: 0 });

    expect(alice.socket.lastReceived('playerJoined')?.data).toMatchObject({
      id: bob.id,
      name: 'Bob',
    });

    const ids = world.engine.getGameState().entities.map((entity) => entity.id);
    expect(ids).toEqual(expect.arrayContaining([alice.id, bob.id]));
  });
});
