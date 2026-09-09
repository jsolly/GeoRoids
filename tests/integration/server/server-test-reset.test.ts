import { expect, test } from 'vitest';
import { createServerInstance } from '../../../server/createServer';
import { RecordingSocket } from '../../support/recordingSocket';

const emptyWorld = {
  isPaused: true,
  humanPlayers: 0,
  bots: 0,
  asteroids: 0,
  loot: 0,
  satellites: 0,
  satellitePickups: 0,
};

test('resetting a populated test world closes its pilot and health reports the empty arena', async () => {
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  try {
    const port = await server.listening;
    const url = `http://127.0.0.1:${port}`;
    server.gameEngine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();
    const socket = new RecordingSocket();
    server.gameEngine.addPlayer('pilot', 'Pilot', socket);
    server.gameEngine.createAsteroids(5);
    server.gameEngine.createBots(2);
    const populated = server.gameEngine.getDiagnostics();
    expect(populated.humanPlayers).toBe(1);
    expect(populated.asteroids).toBeGreaterThan(0);
    expect(populated.bots).toBeGreaterThan(0);

    const reset = await fetch(`${url}/test/reset-world`, {
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    });
    expect(reset.status).toBe(200);
    const resetBody: unknown = await reset.json();
    expect(resetBody).toMatchObject({ status: 'reset', world: emptyWorld });
    expect(socket.readyState).toBe(socket.CLOSED);

    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    expect(health.status).toBe(200);
    const healthBody: unknown = await health.json();
    expect(healthBody).toMatchObject({ world: emptyWorld });
  } finally {
    await server.close();
  }
});

test('production rejects a world reset and preserves the active pilot', async () => {
  const server = createServerInstance({ port: 0, nodeEnv: 'production' });
  try {
    const port = await server.listening;
    server.gameEngine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();
    const socket = new RecordingSocket();
    const pilot = server.gameEngine.addPlayer('pilot', 'Pilot', socket);
    const before = server.gameEngine.getDiagnostics();
    const response = await fetch(`http://127.0.0.1:${port}/test/reset-world`, {
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(404);
    expect(server.gameEngine.getDiagnostics()).toEqual(before);
    expect(server.gameEngine.getPlayer(pilot.id)).toBe(pilot);
    expect(socket.readyState).toBe(socket.OPEN);
  } finally {
    await server.close();
  }
});
