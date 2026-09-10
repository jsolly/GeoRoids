import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { RecordingSocket } from '../../../support/recordingSocket';
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
    world.disconnect(ace);
    expect(world.isOnServer(ace)).toBe(false);

    const socket = new RecordingSocket();
    world.send(
      { id: ace.id, name: ace.name, socket },
      {
        type: 'join',
        id: ace.id,
        name: ace.name,
        data: { name: ace.name, position: { x: 0, y: 0 } },
      }
    );

    const ship = world.entity(ace);
    expect(ship.lives).toBe(2);
    expect(ship.score).toBe(210);
    expect(ship.spawnProtectionTimer).toBeGreaterThan(0);
  });

  test('a new client id with the same name does not leave a second Ace at 3/0', () => {
    const cloneSocket = new RecordingSocket();
    world.send(
      { id: 'ace-clone', name: ace.name, socket: cloneSocket },
      {
        type: 'join',
        id: 'ace-clone',
        name: ace.name,
        data: { name: ace.name, position: { x: 1, y: 1 } },
      }
    );

    expect(world.engine.getPlayerCount()).toBe(1);
    expect(world.engine.getPlayer(ace.id)).toBeUndefined();
    const ship = world.engine.getPlayer('ace-clone');
    expect(ship?.lives).toBe(2);
    expect(ship?.score).toBe(210);
  });
});
