import type { GameEngine } from '../../../server/core/GameEngine';
import { TestConfig } from './test-config';

export type ServerWorldDiagnostics = ReturnType<GameEngine['getDiagnostics']>;
export type BotShotArrangement = {
  playerPosition: { x: number; y: number };
  botPosition: { x: number; y: number };
  botHealth: number;
  motionEpoch?: number;
};

const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 200;
const DEFAULT_WAIT_MS = 15000;

function isWorldDiagnostics(value: unknown): value is ServerWorldDiagnostics {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const world = value as Record<string, unknown>;
  return (
    typeof world['isPaused'] === 'boolean' &&
    typeof world['gameTime'] === 'number' &&
    Number.isFinite(world['gameTime']) &&
    world['gameTime'] >= 0 &&
    ['humanPlayers', 'bots', 'asteroids', 'loot', 'satellites', 'satellitePickups'].every(
      (field) =>
        typeof world[field] === 'number' && Number.isSafeInteger(world[field]) && world[field] >= 0
    )
  );
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'x' in value &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    'y' in value &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

export class TestServerControl {
  static async getWorldDiagnostics(): Promise<ServerWorldDiagnostics> {
    const response = await fetch(`${TestConfig.SERVER_URL}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Health check failed: HTTP ${response.status}`);
    }
    const parsed: unknown = await response.json();
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('world' in parsed) ||
      !isWorldDiagnostics(parsed.world)
    ) {
      throw new Error('Health response omitted valid world diagnostics');
    }
    return parsed.world;
  }

  static isWorldClean(world: ServerWorldDiagnostics): boolean {
    return (
      world.isPaused &&
      world.humanPlayers === 0 &&
      world.bots === 0 &&
      world.asteroids === 0 &&
      world.loot === 0 &&
      world.satellites === 0 &&
      world.satellitePickups === 0
    );
  }

  static async resetWorld(): Promise<void> {
    const response = await fetch(`${TestConfig.SERVER_URL}/test/reset-world`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`World reset failed: HTTP ${response.status}`);
    }
    await TestServerControl.waitForWorldReset();
  }

  static async placePlayer(
    playerId: string,
    position: { x: number; y: number }
  ): Promise<{ motionEpoch?: number }> {
    const response = await fetch(`${TestConfig.SERVER_URL}/test/place-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, position }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Player fixture placement failed: HTTP ${response.status}`);
    }
    const result: unknown = await response.json();
    if (
      typeof result !== 'object' ||
      result === null ||
      !('status' in result) ||
      result.status !== 'placed' ||
      !('playerId' in result) ||
      result.playerId !== playerId ||
      !('position' in result) ||
      typeof result.position !== 'object' ||
      result.position === null ||
      !('x' in result.position) ||
      result.position.x !== position.x ||
      !('y' in result.position) ||
      result.position.y !== position.y
    ) {
      throw new Error('Player fixture placement returned an invalid response');
    }
    if (
      'motionEpoch' in result &&
      (typeof result.motionEpoch !== 'number' ||
        !Number.isSafeInteger(result.motionEpoch) ||
        result.motionEpoch < 0)
    ) {
      throw new Error('Player fixture placement returned an invalid motion epoch');
    }
    return 'motionEpoch' in result ? { motionEpoch: result.motionEpoch as number } : {};
  }

  static async arrangeBotShot(playerId: string, botId: string): Promise<BotShotArrangement> {
    const response = await fetch(`${TestConfig.SERVER_URL}/test/arrange-bot-shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, botId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Bot shot fixture arrangement failed: HTTP ${response.status}`);
    }
    const result: unknown = await response.json();
    if (
      typeof result !== 'object' ||
      result === null ||
      !('status' in result) ||
      result.status !== 'arranged' ||
      !('playerId' in result) ||
      result.playerId !== playerId ||
      !('botId' in result) ||
      result.botId !== botId ||
      !('playerPosition' in result) ||
      !isPosition(result.playerPosition) ||
      !('botPosition' in result) ||
      !isPosition(result.botPosition) ||
      !('botHealth' in result) ||
      typeof result.botHealth !== 'number' ||
      !Number.isFinite(result.botHealth) ||
      result.botHealth <= 0
    ) {
      throw new Error('Bot shot fixture arrangement returned an invalid response');
    }
    if (
      'motionEpoch' in result &&
      (typeof result.motionEpoch !== 'number' ||
        !Number.isSafeInteger(result.motionEpoch) ||
        result.motionEpoch < 0)
    ) {
      throw new Error('Bot shot fixture arrangement returned an invalid motion epoch');
    }
    return {
      playerPosition: result.playerPosition,
      botPosition: result.botPosition,
      botHealth: result.botHealth,
      ...('motionEpoch' in result ? { motionEpoch: result.motionEpoch as number } : {}),
    };
  }

  static async waitForWorldReset(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const world = await TestServerControl.getWorldDiagnostics();
      if (TestServerControl.isWorldClean(world)) {
        return;
      }
      await sleep(DEFAULT_POLL_MS);
    }

    const world = await TestServerControl.getWorldDiagnostics();
    throw new Error(`Timed out waiting for server world reset: ${JSON.stringify(world)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
