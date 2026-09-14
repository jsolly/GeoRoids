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
    const gameTime = world.engine.getDiagnostics().gameTime;
    world.disconnect(host);

    expect(world.isOnServer(host)).toBe(false);
    expect(world.isOnServer(guest)).toBe(true);
    expect(world.engine.isGamePaused()).toBe(false);
    expect(world.entity(guest).health).toBeGreaterThan(0);
    expect(world.engine.getDiagnostics().gameTime).toBe(gameTime);

    world.move(guest, { x: 87.5, y: 5 });
    expect(world.entity(guest).position).toEqual({ x: 87.5, y: 5 });
    world.tick();
    expect(world.engine.getDiagnostics().gameTime).toBe(gameTime + 1);
  });
});
