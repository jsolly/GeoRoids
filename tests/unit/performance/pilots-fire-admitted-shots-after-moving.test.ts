/* @vitest-environment node */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { Pilot } from '../../../benchmarks/pilot';
import { createServerInstance } from '../../../server/createServer';
import { GAME, LASER } from '../../../src/constants';

test('a benchmark pilot moves and fires a shot that the authoritative world publishes', async () => {
  const server = createServerInstance({ port: 0, nodeEnv: 'test', seed: 42 });
  server.gameEngine.stopGameLoop();
  server.wsCore.stopPeriodicGameStateBroadcast();
  const port = await server.listening;
  const failures: unknown[] = [];
  const pilot = new Pilot(0, {
    url: new URL(`ws://127.0.0.1:${port}/ws?asteroidInteractions=1`),
    measuring: () => false,
    fail: (error) => failures.push(error),
  });
  try {
    const deadline = AbortSignal.timeout(2000);
    while (!pilot.state) {
      await once(pilot.socket, 'message', { signal: deadline });
    }
    const actor = server.gameEngine.getPlayer(pilot.id);
    assert(actor);
    actor.position = { x: 0, y: 0 };
    actor.velocity = { x: 0, y: 0 };
    actor.angle = 0;
    for (const bot of server.gameEngine.getAllBots()) {
      server.gameEngine.removeBot(bot.id);
    }
    for (const rock of server.gameEngine.getAllAsteroids()) {
      server.gameEngine.removeAsteroid(rock.id);
    }
    for (const { id } of server.gameEngine.getAllSatellites()) {
      const satellite = server.gameEngine.getSatellite(id);
      assert(satellite);
      satellite.position = { x: -2400, y: -2400 };
    }
    const barrier = async () => {
      const pong = once(pilot.socket, 'pong', { signal: AbortSignal.timeout(2000) });
      pilot.socket.ping();
      await pong;
    };
    server.wsCore.getBroadcaster().broadcastGameState();
    await barrier();
    // Broadcasting can replenish the field; isolate the actual shot corridor again.
    for (const rock of server.gameEngine.getAllAsteroids()) {
      server.gameEngine.removeAsteroid(rock.id);
    }
    pilot.drive(10);
    await barrier();
    expect(actor.position.x).toBeCloseTo(Math.cos(0.4));
    expect(actor.position.y).toBeCloseTo(Math.sin(0.4));
    const shots = server.gameEngine.getServerLasers();
    expect(shots).toHaveLength(1);
    const shot = shots[0];
    assert(shot);
    expect(shot.ownerId).toBe(pilot.id);
    expect(shot.velocity.x).toBe(LASER.SPEED / GAME.FPS);
    expect(shot.velocity.y).toBe(0);
    server.wsCore.getBroadcaster().broadcastGameState();
    await barrier();
    expect(pilot.state?.playerProjectiles.map((projectile) => projectile.id)).toContain(shot.id);
    expect(failures).toEqual([]);
  } finally {
    try {
      await pilot.close();
    } finally {
      await server.close();
    }
  }
});
