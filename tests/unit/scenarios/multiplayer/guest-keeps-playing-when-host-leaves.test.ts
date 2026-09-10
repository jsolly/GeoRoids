import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('The guest keeps playing when the host leaves', () => {
  let world: GameServerWorld;
  let host: Pilot;
  let guest: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    host = world.join('Host');
    guest = world.join('Guest', { x: 80, y: 0 });
    world.wearOffJoinInvulnerability();
  });

  afterEach(() => {
    world.dispose();
  });

  test('closing the host tab does not reset the guest or the clock', () => {
    world.disconnect(host);

    expect(world.isOnServer(host)).toBe(false);
    expect(world.isOnServer(guest)).toBe(true);
    expect(world.engine.isGamePaused()).toBe(false);
    expect(world.entity(guest).health).toBeGreaterThan(0);

    world.move(guest, { x: 140, y: 20 });
    expect(world.entity(guest).position).toEqual({ x: 140, y: 20 });
  });
});
