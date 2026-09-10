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
    ship.lives = 2;
    ship.score = 210;
  });

  afterEach(() => {
    world.dispose();
  });

  test('the same pilot id comes back with the same lives and score, not a fresh 3/0', () => {
    world.dropTransport(ace);
    expect(world.engine.getPlayerBySocket(ace.socket)).toBeUndefined();
    ace = world.resume(ace);

    const ship = world.entity(ace);
    expect(ship.lives).toBe(2);
    expect(ship.score).toBe(210);
    expect(ship.spawnProtectionTimer ?? 0).toBe(0);
  });

  test('a new client id with the same name does not leave a second Ace at 3/0', () => {
    const cloneSocket = world.attemptJoin('ace-clone', ace.name, { x: 1, y: 1 });

    expect(world.engine.getPlayerCount()).toBe(1);
    expect(world.engine.getPlayer(ace.id)).toBeDefined();
    expect(world.engine.getPlayer('ace-clone')).toBeUndefined();
    expect(cloneSocket.received('joined')).toHaveLength(0);
    expect(cloneSocket.received('error')).toHaveLength(1);
  });
});
