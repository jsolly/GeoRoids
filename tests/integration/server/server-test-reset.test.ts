import { expect, test, vi } from 'vitest';
import { createServerInstance } from '../../../server/createServer';
import { logger } from '../../../setup/serverLogger';
import { RecordingSocket } from '../../support/recordingSocket';

class TrackingSocket extends RecordingSocket {
  closeAttempts = 0;

  constructor(private readonly throwsOnClose = false) {
    super();
  }

  override close(code = 1000, data: string | Buffer = ''): void {
    this.closeAttempts += 1;
    if (this.throwsOnClose) {
      throw new Error('fixture close failed');
    }
    super.close(code, data);
  }
}

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
    server.gameEngine.advanceOneFrame();
    const socket = new RecordingSocket();
    server.gameEngine.addPlayer('pilot', 'Pilot', socket);
    server.gameEngine.createAsteroids(5);
    server.gameEngine.createBots(2);
    const populated = server.gameEngine.getDiagnostics();
    expect(populated.gameTime).toBeGreaterThan(0);
    expect(populated.humanPlayers).toBe(1);
    expect(populated.asteroids).toBeGreaterThan(0);
    expect(populated.bots).toBeGreaterThan(0);

    const reset = await fetch(`${url}/test/reset-world`, {
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    });
    expect(reset.status).toBe(200);
    const resetBody: unknown = await reset.json();
    expect(resetBody).toMatchObject({
      status: 'reset',
      world: { ...emptyWorld, gameTime: populated.gameTime },
    });
    expect(socket.readyState).toBe(socket.CLOSED);

    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    expect(health.status).toBe(200);
    const healthBody: unknown = await health.json();
    expect(healthBody).toMatchObject({ world: { ...emptyWorld, gameTime: populated.gameTime } });
  } finally {
    await server.close();
  }
});

test('a reset attempts every pilot close and reports a socket cleanup failure', async () => {
  const errorLog = vi.spyOn(logger, 'error');
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  try {
    const port = await server.listening;
    server.gameEngine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();
    const failingSocket = new TrackingSocket(true);
    const healthySocket = new TrackingSocket();
    server.gameEngine.addPlayer('pilot-a', 'Pilot A', failingSocket);
    server.gameEngine.addPlayer('pilot-b', 'Pilot B', healthySocket);
    server.gameEngine.createAsteroids(5);
    const before = server.gameEngine.getDiagnostics();

    const response = await fetch(`http://127.0.0.1:${port}/test/reset-world`, {
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Test world reset failed' });
    expect(server.gameEngine.getDiagnostics()).toEqual(before);
    expect(server.gameEngine.getPlayer('pilot-a')).toBeDefined();
    expect(server.gameEngine.getPlayer('pilot-b')).toBeDefined();
    expect(failingSocket.closeAttempts).toBe(1);
    expect(healthySocket.closeAttempts).toBe(1);
    expect(failingSocket.readyState).toBe(failingSocket.OPEN);
    expect(healthySocket.readyState).toBe(healthySocket.CLOSED);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('TEST_RESET_FAILED', {
      operation: 'reset test world',
      action: 'close or replace the failing human socket, then retry',
      error: {
        message: 'Test world reset could not close every human socket',
        failures: [
          {
            message: 'Failed to close socket for player pilot-a',
            cause: expect.objectContaining({ message: 'fixture close failed' }),
          },
        ],
      },
    });
  } finally {
    try {
      await server.close();
    } finally {
      errorLog.mockRestore();
    }
  }
});

test('a reset skips an already-closed pilot socket and clears the world', async () => {
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  try {
    await server.listening;
    server.gameEngine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();
    const socket = new TrackingSocket();
    socket.close();
    server.gameEngine.addPlayer('pilot', 'Pilot', socket);
    server.gameEngine.createAsteroids(5);

    const gameTime = server.gameEngine.getDiagnostics().gameTime;
    server.gameEngine.resetForTesting();

    expect(socket.closeAttempts).toBe(1);
    expect(socket.readyState).toBe(socket.CLOSED);
    expect(server.gameEngine.getDiagnostics()).toEqual({ ...emptyWorld, gameTime });
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
