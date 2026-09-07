import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServerInstance } from '../../../server/createServer';

describe('Server test world reset', () => {
  let server: Awaited<ReturnType<typeof createServerInstance>>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('exposes world diagnostics on /health', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.ok).toBe(true);

    const body = await response.json();
    expect(body.world).toMatchObject({
      isPaused: true,
      humanPlayers: 0,
      bots: 0,
      asteroids: 0,
      satellitePickups: 0,
    });
  });

  it('POST /test/reset-world clears humans, bots, and asteroids', async () => {
    const mockWs = {} as any;
    server.gameEngine.addPlayer('reset-test-player', 'ResetTest', mockWs);
    server.gameEngine.createAsteroids(5);
    server.gameEngine.createBots(2);

    expect(server.gameEngine.getDiagnostics().humanPlayers).toBe(1);
    expect(server.gameEngine.getDiagnostics().asteroids).toBeGreaterThan(0);
    expect(server.gameEngine.getDiagnostics().bots).toBeGreaterThan(0);

    const response = await fetch(`${baseUrl}/test/reset-world`, { method: 'POST' });
    expect(response.ok).toBe(true);

    const body = await response.json();
    expect(body.status).toBe('reset');
    expect(body.world).toMatchObject({
      isPaused: true,
      humanPlayers: 0,
      bots: 0,
      asteroids: 0,
      satellitePickups: 0,
    });
  });

  it('POST /test/reset-world is unavailable in production mode', async () => {
    const prodServer = createServerInstance({ port: 0, nodeEnv: 'production' });
    const port = await prodServer.listening;
    const response = await fetch(`http://127.0.0.1:${port}/test/reset-world`, { method: 'POST' });
    expect(response.status).toBe(404);
    await prodServer.close();
  });
});
