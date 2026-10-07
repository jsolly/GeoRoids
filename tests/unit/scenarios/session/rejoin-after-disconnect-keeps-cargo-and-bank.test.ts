import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('Rejoin after a dropped socket', () => {
  let world: GameServerWorld;
  let ace: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    ace = world.join('Ace');
    world.wearOffJoinInvulnerability();
    const ship = world.entity(ace);
    ship.score = 210;
    ship.cargo = 123;
  });

  afterEach(() => {
    world.dispose();
  });

  test('a new client id with the same name does not create a duplicate pilot', () => {
    const cloneSocket = world.attemptJoin('ace-clone', ace.name, { x: 1, y: 1 });

    expect(world.engine.getPlayerCount()).toBe(1);
    expect(world.engine.getPlayer(ace.id)).toBeDefined();
    expect(world.engine.getPlayer('ace-clone')).toBeUndefined();
    expect(cloneSocket.received('joined')).toHaveLength(0);
    expect(cloneSocket.received('error')).toHaveLength(1);
  });
});
