import type { GameEngine } from '../../../server/core/GameEngine';
import type { AsteroidData, SpiderFieldState, TerrainSpider } from '../../../shared-types';
import { TestConfig } from './test-config';

type FixtureState = {
  observedRocks: AsteroidData[];
  spiderField: Omit<SpiderFieldState, 'spiders'> & {
    spiders: (TerrainSpider & { towedBy: string | null })[];
  };
  crawlers: TerrainSpider[];
  combat: ReturnType<GameEngine['getFixtureCombatEvidence']>;
  world: ServerWorldDiagnostics;
  seed: number;
  controlledRocks: {
    id: string;
    position: { x: number; y: number };
    velocity: { x: number; y: number };
  }[];
  sockets: { total: number; open: number };
  players: {
    id: string;
    cargo: number;
    score: number;
    kitId: string;
    harpoonTargetId: string | null;
    haulerUtility: string | null;
    abilityCooldownFrames: number;
    health: number;
    exploding: boolean;
    position: { x: number; y: number };
    velocity: { x: number; y: number };
    socketState: number | null;
    motionEpoch: number | null;
    furnaceTransit: unknown;
    spawnProtectionTimer: number;
  }[];
};

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

async function fixtureFailure(response: Response, operation: string): Promise<never> {
  const body = await response.text();
  throw new Error(`${operation}: HTTP ${response.status} ${body}`);
}

export async function getFixtureState(
  asteroidIds: readonly string[] = [],
  observePlayerShots?: readonly string[]
): Promise<FixtureState> {
  const response = await fetch(`${TestConfig.SERVER_URL}/test/fixture-state`, {
    method: 'POST',
    body: JSON.stringify({ asteroidIds, observePlayerShots }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return fixtureFailure(response, 'Fixture observation failed');
  }
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== 'object' ||
    !('spiderField' in value) ||
    !value.spiderField ||
    typeof value.spiderField !== 'object' ||
    !('spiders' in value.spiderField) ||
    !Array.isArray(value.spiderField.spiders) ||
    !('nests' in value.spiderField) ||
    !Array.isArray(value.spiderField.nests) ||
    !('world' in value) ||
    !isWorldDiagnostics(value.world) ||
    !('seed' in value) ||
    typeof value.seed !== 'number' ||
    !Number.isSafeInteger(value.seed) ||
    !('sockets' in value) ||
    !value.sockets ||
    typeof value.sockets !== 'object' ||
    !('total' in value.sockets) ||
    typeof value.sockets.total !== 'number' ||
    !Number.isSafeInteger(value.sockets.total) ||
    value.sockets.total < 0 ||
    !('open' in value.sockets) ||
    typeof value.sockets.open !== 'number' ||
    !Number.isSafeInteger(value.sockets.open) ||
    value.sockets.open < 0 ||
    value.sockets.open > value.sockets.total ||
    !('players' in value) ||
    !Array.isArray(value.players) ||
    value.players.some(
      (player: unknown) =>
        !player ||
        typeof player !== 'object' ||
        !('id' in player) ||
        typeof player.id !== 'string' ||
        !('cargo' in player) ||
        typeof player.cargo !== 'number' ||
        !('score' in player) ||
        typeof player.score !== 'number' ||
        !('kitId' in player) ||
        typeof player.kitId !== 'string' ||
        !('harpoonTargetId' in player) ||
        (player.harpoonTargetId !== null && typeof player.harpoonTargetId !== 'string') ||
        !('haulerUtility' in player) ||
        (player.haulerUtility !== null && typeof player.haulerUtility !== 'string') ||
        !('abilityCooldownFrames' in player) ||
        typeof player.abilityCooldownFrames !== 'number' ||
        !('health' in player) ||
        typeof player.health !== 'number' ||
        !('exploding' in player) ||
        typeof player.exploding !== 'boolean' ||
        !('position' in player) ||
        !player.position ||
        typeof player.position !== 'object' ||
        !('x' in player.position) ||
        typeof player.position.x !== 'number' ||
        !('y' in player.position) ||
        typeof player.position.y !== 'number' ||
        !('motionEpoch' in player) ||
        (player.motionEpoch !== null &&
          (typeof player.motionEpoch !== 'number' ||
            !Number.isSafeInteger(player.motionEpoch) ||
            player.motionEpoch < 0)) ||
        !('socketState' in player) ||
        (player.socketState !== null &&
          (typeof player.socketState !== 'number' || ![0, 1, 2, 3].includes(player.socketState))) ||
        !('velocity' in player) ||
        !player.velocity ||
        typeof player.velocity !== 'object' ||
        !('x' in player.velocity) ||
        typeof player.velocity.x !== 'number' ||
        !('y' in player.velocity) ||
        typeof player.velocity.y !== 'number' ||
        !('furnaceTransit' in player) ||
        !('spawnProtectionTimer' in player) ||
        typeof player.spawnProtectionTimer !== 'number'
    )
  ) {
    throw new Error('Fixture observation returned invalid state');
  }
  return value as FixtureState;
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
    return fixtureFailure(response, 'World reset failed');
  }
  await waitForWorldReset();
}

export async function placePlayer(
  playerId: string,
  position: { x: number; y: number },
  options: {
    clearSpawnProtection?: boolean;
    expectedTowTargetId?: string;
    atTowTarget?: boolean;
  } = {}
): Promise<{
  motionEpoch?: number;
  position: { x: number; y: number };
  atTowTarget: boolean;
  expectedTowTargetId: string | null;
  towOwnerId: string | null;
  towTargetId: string | null;
  placedActorTowTargetId: string | null;
  spawnProtectionCleared: boolean;
  spawnProtectionTimer: number;
}> {
  const response = await fetch(`${TestConfig.SERVER_URL}/test/place-player`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, position, ...options }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return fixtureFailure(response, 'Player fixture placement failed');
  }
  const result: unknown = await response.json();
  if (
    typeof result !== 'object' ||
    result === null ||
    !('atTowTarget' in result) ||
    result.atTowTarget !== (options.atTowTarget === true) ||
    !('expectedTowTargetId' in result) ||
    result.expectedTowTargetId !== (options.expectedTowTargetId ?? null) ||
    !('towOwnerId' in result) ||
    (options.expectedTowTargetId !== undefined
      ? typeof result.towOwnerId !== 'string'
      : result.towOwnerId !== null) ||
    !('towTargetId' in result) ||
    result.towTargetId !== (options.expectedTowTargetId ?? null) ||
    !('placedActorTowTargetId' in result) ||
    (result.placedActorTowTargetId !== null && typeof result.placedActorTowTargetId !== 'string') ||
    (result.towOwnerId === playerId &&
      result.placedActorTowTargetId !== options.expectedTowTargetId) ||
    !('spawnProtectionCleared' in result) ||
    result.spawnProtectionCleared !== (options.clearSpawnProtection === true) ||
    !('spawnProtectionTimer' in result) ||
    typeof result.spawnProtectionTimer !== 'number' ||
    !Number.isFinite(result.spawnProtectionTimer) ||
    result.spawnProtectionTimer < 0 ||
    (options.clearSpawnProtection === true && result.spawnProtectionTimer !== 0) ||
    !('status' in result) ||
    result.status !== 'placed' ||
    !('playerId' in result) ||
    result.playerId !== playerId ||
    !('position' in result) ||
    typeof result.position !== 'object' ||
    result.position === null ||
    !('x' in result.position) ||
    typeof result.position.x !== 'number' ||
    !Number.isFinite(result.position.x) ||
    !('y' in result.position) ||
    typeof result.position.y !== 'number' ||
    !Number.isFinite(result.position.y) ||
    (options.atTowTarget !== true &&
      (result.position.x !== position.x || result.position.y !== position.y))
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
  return {
    position: { x: result.position.x, y: result.position.y },
    atTowTarget: result.atTowTarget,
    expectedTowTargetId: result.expectedTowTargetId as string | null,
    towOwnerId: result.towOwnerId as string | null,
    towTargetId: result.towTargetId as string | null,
    placedActorTowTargetId: result.placedActorTowTargetId as string | null,
    spawnProtectionCleared: result.spawnProtectionCleared,
    spawnProtectionTimer: result.spawnProtectionTimer,
    ...('motionEpoch' in result ? { motionEpoch: result.motionEpoch as number } : {}),
  };
}

async function waitForWorldReset(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getFixtureState();
    if (isWorldClean(state.world) && state.sockets.total === 0) {
      return;
    }
    await sleep(DEFAULT_POLL_MS);
  }

  const state = await getFixtureState();
  throw new Error(`Timed out waiting for server world reset/departure: ${JSON.stringify(state)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function arrangeCrewFieldWithEvidence(
  playerIds: string[],
  scenario:
    | 'delivery'
    | 'tow'
    | 'empty'
    | 'equipment'
    | 'boundary'
    | 'impact'
    | 'mining'
    | 'hull-recovery'
    | 'cooperative'
    | 'reflection'
    | 'satellite'
    | 'probe'
    | 'spider-nest'
    | 'spider-tools'
    | 'spider-rescue'
    | 'spider-tow-bite'
    | 'pinball'
    | 'shared-field'
    | 'belt-mining'
    | 'belt-escape'
    | 'belt-pursuit'
    | 'map-icons'
    | 'furnace'
    | 'town-store'
    | 'cargo'
    | 'full-cargo'
    | 'settlement-delivery'
    | 'furnace-build'
    | 'street-escape'
    | 'street-travel'
): Promise<{
  epochs: ReadonlyMap<string, number>;
  positions: ReadonlyMap<string, Readonly<{ x: number; y: number }>>;
  asteroidId: string | null;
  playersBefore: { id: string; cargo: number; score: number; kitId: string }[];
  playersAfter: { id: string; cargo: number; score: number; kitId: string }[];
}> {
  const response = await fetch(`${TestConfig.SERVER_URL}/test/arrange-crew-field`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerIds, scenario }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return fixtureFailure(response, 'Crew fixture failed');
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'arranged') {
    throw new Error('Invalid crew fixture response');
  }
  if (!('poses' in body) || !Array.isArray(body.poses)) {
    throw new Error('Missing crew fixture poses');
  }
  const epochs = new Map<string, number>();
  const positions = new Map<string, Readonly<{ x: number; y: number }>>();
  for (const pose of body.poses) {
    if (
      !pose ||
      typeof pose !== 'object' ||
      !('playerId' in pose) ||
      typeof pose.playerId !== 'string' ||
      !('motionEpoch' in pose) ||
      typeof pose.motionEpoch !== 'number' ||
      !Number.isSafeInteger(pose.motionEpoch) ||
      !('position' in pose) ||
      !pose.position ||
      typeof pose.position !== 'object' ||
      !('x' in pose.position) ||
      typeof pose.position.x !== 'number' ||
      !Number.isFinite(pose.position.x) ||
      !('y' in pose.position) ||
      typeof pose.position.y !== 'number' ||
      !Number.isFinite(pose.position.y)
    ) {
      throw new Error('Invalid crew fixture pose');
    }
    if (epochs.has(pose.playerId)) {
      throw new Error('Crew fixture duplicated a requested pilot');
    }
    epochs.set(pose.playerId, pose.motionEpoch);
    positions.set(pose.playerId, Object.freeze({ x: pose.position.x, y: pose.position.y }));
  }
  if (epochs.size !== playerIds.length || playerIds.some((id) => !epochs.has(id))) {
    throw new Error('Crew fixture omitted or duplicated a requested pilot');
  }
  if (
    !('asteroidId' in body) ||
    (body.asteroidId !== null && typeof body.asteroidId !== 'string') ||
    !('playersBefore' in body) ||
    !Array.isArray(body.playersBefore) ||
    !('playersAfter' in body) ||
    !Array.isArray(body.playersAfter)
  ) {
    throw new Error('Missing crew fixture baseline');
  }
  const readPlayers = (rows: unknown[]) =>
    rows.map((row) => {
      if (
        !row ||
        typeof row !== 'object' ||
        !('id' in row) ||
        typeof row.id !== 'string' ||
        !('cargo' in row) ||
        typeof row.cargo !== 'number' ||
        !('score' in row) ||
        typeof row.score !== 'number' ||
        !('kitId' in row) ||
        typeof row.kitId !== 'string'
      ) {
        throw new Error('Invalid crew fixture baseline');
      }
      return { id: row.id, cargo: row.cargo, score: row.score, kitId: row.kitId };
    });
  return {
    epochs,
    positions,
    asteroidId: body.asteroidId,
    playersBefore: readPlayers(body.playersBefore),
    playersAfter: readPlayers(body.playersAfter),
  };
}

export async function arrangeCrewField(
  playerIds: string[],
  scenario: Parameters<typeof arrangeCrewFieldWithEvidence>[1]
): Promise<ReadonlyMap<string, number>> {
  return (await arrangeCrewFieldWithEvidence(playerIds, scenario)).epochs;
}
