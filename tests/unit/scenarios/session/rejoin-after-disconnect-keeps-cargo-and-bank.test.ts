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

  test('the same pilot id comes back with the same cargo and bank', () => {
    world.dropTransport(ace);
    expect(world.engine.getPlayerBySocket(ace.socket)).toBeUndefined();
    ace = world.resume(ace);

    const ship = world.entity(ace);
    expect(ship.score).toBe(210);
    expect(ship.cargo).toBe(123);
    expect(ship.spawnProtectionTimer ?? 0).toBe(0);
  });

  test('leaving then entering again returns to the same ship with the saved score', () => {
    const ship = world.entity(ace);
    ship.position = { x: 2_400, y: 1_800 };
    world.disconnect(ace);
    ace = world.resume(ace, { x: 0, y: 0 });

    const next = world.entity(ace);
    expect(next.score).toBe(210);
    expect(next.position).toEqual({ x: 2_400, y: 1_800 });
    expect(next.spawnProtectionTimer ?? 0).toBe(0);
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
