import type { GameEngine } from '../../../server/core/GameEngine';
import { TestConfig } from './test-config';

type ServerWorldDiagnostics = ReturnType<GameEngine['getDiagnostics']>;
export type BotShotArrangement = {
  playerPosition: { x: number; y: number };
  botPosition: { x: number; y: number };
  botHealth: number;
  motionEpoch?: number;
};

const BOT_SHIELD_ACTIVE_REASON = 'Fixture bot shield is active';

export class BotShotArrangementHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string
  ) {
    super(`Bot shot fixture arrangement failed: HTTP ${status}: ${reason}`);
    this.name = 'BotShotArrangementHttpError';
  }
}

export function isBotShieldActiveError(error: unknown): error is BotShotArrangementHttpError {
  return (
    error instanceof BotShotArrangementHttpError &&
    error.status === 409 &&
    error.reason === BOT_SHIELD_ACTIVE_REASON
  );
}

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

function isErrorBody(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string' &&
    value.error.length > 0
  );
}

async function readArrangementErrorReason(response: Response): Promise<string> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'invalid JSON error body';
  }
  return isErrorBody(parsed) ? parsed.error : 'invalid error body';
}

export async function getWorldDiagnostics(): Promise<ServerWorldDiagnostics> {
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

export function isWorldClean(world: ServerWorldDiagnostics): boolean {
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

export async function resetWorld(): Promise<void> {
  const response = await fetch(`${TestConfig.SERVER_URL}/test/reset-world`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`World reset failed: HTTP ${response.status}`);
  }
  await waitForWorldReset();
}

export async function placePlayer(
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

export async function arrangeBotShot(
  playerId: string,
  botId: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<BotShotArrangement> {
  const requestTimeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeoutMs));
  const response = await fetch(`${TestConfig.SERVER_URL}/test/arrange-bot-shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, botId }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new BotShotArrangementHttpError(
      response.status,
      await readArrangementErrorReason(response)
    );
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

export async function waitForWorldReset(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const world = await getWorldDiagnostics();
    if (isWorldClean(world)) {
      return;
    }
    await sleep(DEFAULT_POLL_MS);
  }

  const world = await getWorldDiagnostics();
  throw new Error(`Timed out waiting for server world reset: ${JSON.stringify(world)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
