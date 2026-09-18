import type { GameEngine } from '../../../server/core/GameEngine';
import { TestConfig } from './test-config';

type ServerWorldDiagnostics = ReturnType<GameEngine['getDiagnostics']>;
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
    ['players', 'asteroids', 'loot', 'satellitePickups'].every(
      (field) =>
        typeof world[field] === 'number' && Number.isSafeInteger(world[field]) && world[field] >= 0
    )
  );
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
    world.players === 0 &&
    world.asteroids === 0 &&
    world.loot === 0 &&
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

async function waitForWorldReset(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
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

export async function arrangeCrewField(
  playerIds: string[],
  scenario:
    | 'delivery'
    | 'tow'
    | 'empty'
    | 'boundary'
    | 'impact'
    | 'mining'
    | 'cooperative'
    | 'reflection'
): Promise<void> {
  const response = await fetch(`${TestConfig.SERVER_URL}/test/arrange-crew-field`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerIds, scenario }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Crew fixture failed: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'arranged') {
    throw new Error('Invalid crew fixture response');
  }
}
