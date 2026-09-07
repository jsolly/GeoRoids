import http from 'node:http';
import { TestConfig } from './test-config';

export type ServerWorldDiagnostics = {
  isPaused: boolean;
  gameTime: number;
  humanPlayers: number;
  bots: number;
  asteroids: number;
  satellites?: number;
};

type HealthResponse = {
  world?: ServerWorldDiagnostics;
};

const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 200;
const DEFAULT_WAIT_MS = 15000;

function httpRequest(
  url: string,
  method: 'GET' | 'POST' = 'GET'
): Promise<{ ok: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ ok: response.statusCode === 200, body });
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', reject);
    request.end();
  });
}

export class TestServerControl {
  static async getWorldDiagnostics(): Promise<ServerWorldDiagnostics> {
    const { ok, body } = await httpRequest(`${TestConfig.SERVER_URL}/health`);
    if (!ok) {
      throw new Error('Health check failed');
    }

    const parsed = JSON.parse(body) as HealthResponse & { players?: number };
    if (parsed.world) {
      return parsed.world;
    }

    // Legacy /health payload before world diagnostics were added.
    const humanPlayers = parsed.players ?? 0;
    return {
      isPaused: humanPlayers === 0,
      gameTime: 0,
      humanPlayers,
      bots: 0,
      asteroids: humanPlayers === 0 ? 0 : -1,
      satellites: humanPlayers === 0 ? 0 : -1,
    };
  }

  static isWorldClean(world: ServerWorldDiagnostics): boolean {
    if (world.humanPlayers !== 0 || !world.isPaused) {
      return false;
    }
    return world.asteroids <= 0;
  }

  static async resetWorld(): Promise<void> {
    try {
      const { ok } = await httpRequest(`${TestConfig.SERVER_URL}/test/reset-world`, 'POST');
      if (ok) {
        await this.waitForWorldReset();
        return;
      }
    } catch {
      // Fall through to disconnect-only barrier for older dev servers.
    }

    await this.waitForPlayersDisconnected();
  }

  static async waitForPlayersDisconnected(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const world = await this.getWorldDiagnostics();
      if (world.humanPlayers === 0) {
        return;
      }
      await sleep(DEFAULT_POLL_MS);
    }
    throw new Error('Timed out waiting for all players to disconnect');
  }

  static async waitForWorldReset(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const world = await this.getWorldDiagnostics();
      if (this.isWorldClean(world)) {
        return;
      }
      await sleep(DEFAULT_POLL_MS);
    }

    const world = await this.getWorldDiagnostics();
    throw new Error(`Timed out waiting for server world reset: ${JSON.stringify(world)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
