import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';
import { logger } from '../setup/serverLogger';
import { calculateHealthRegenDelayFrames } from '../shared/constants/health';
import { WORLD } from '../shared/world';
import { DAMAGE } from '../src/constants';
import type { WebSocketCore } from './communication/WebSocketCore';
import type { GameEngine } from './core/GameEngine';
import type { ServerPerformanceSummary } from './performanceMetrics';
import { SERVER_RELEASE_ID } from './release';

const TEST_FIXTURE_MAX_BYTES = 1024;
const TEST_FIXTURE_MAX_COORDINATE = 100_000;
const TEST_FIXTURE_BODY_TIMEOUT_MS = 2000;

type TestResponder = (status: number, body: Record<string, unknown>) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function acceptTestPost(
  req: IncomingMessage,
  res: ServerResponse,
  nodeEnv: string
): boolean {
  if (!areTestHttpEndpointsEnabled(nodeEnv) || !isLoopbackRequest(req)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return false;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return false;
  }
  return true;
}

function readBoundedTestJson(
  req: IncomingMessage,
  res: ServerResponse,
  onBody: (body: unknown, respond: TestResponder) => void
): void {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > TEST_FIXTURE_MAX_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Fixture payload too large' }));
    req.resume();
    return;
  }

  const chunks: Buffer[] = [];
  let received = 0;
  let completed = false;
  const respond: TestResponder = (status, body) => {
    if (completed) {
      return;
    }
    completed = true;
    clearTimeout(bodyTimeout);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const bodyTimeout = setTimeout(() => {
    res.once('finish', () => req.destroy());
    respond(408, { error: 'Fixture payload timed out' });
  }, TEST_FIXTURE_BODY_TIMEOUT_MS);
  bodyTimeout.unref();
  req.on('data', (chunk: Buffer | string) => {
    if (completed) {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.length;
    if (received > TEST_FIXTURE_MAX_BYTES) {
      chunks.length = 0;
      res.once('finish', () => req.destroy());
      respond(413, { error: 'Fixture payload too large' });
      return;
    }
    chunks.push(bytes);
  });
  req.on('end', () => {
    if (completed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      respond(400, { error: 'Invalid fixture payload' });
      return;
    }
    onBody(parsed, respond);
  });
  req.on('error', () => {
    respond(400, { error: 'Invalid fixture payload' });
  });
  req.on('aborted', () => {
    completed = true;
    clearTimeout(bodyTimeout);
  });
  req.on('close', () => {
    if (!req.complete) {
      completed = true;
      clearTimeout(bodyTimeout);
    }
  });
}

/** Test-only HTTP routes — enabled only in local dev and Vitest, never in production. */
export function areTestHttpEndpointsEnabled(nodeEnv: string): boolean {
  return nodeEnv === 'test' || nodeEnv === 'development';
}

export function buildHealthPayload(
  wsCore: WebSocketCore,
  gameEngine: GameEngine,
  logging?: Record<string, unknown>,
  metrics?: ServerPerformanceSummary
): Record<string, unknown> {
  const diagnostics = gameEngine.getDiagnostics();
  return {
    status: gameEngine.isPersistenceHealthy() ? 'healthy' : 'unhealthy',
    releaseId: SERVER_RELEASE_ID,
    timestamp: new Date().toISOString(),
    players: wsCore.getPlayerCount(),
    uptime: process.uptime(),
    world: diagnostics,
    ...(logging ? { logging } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

export function handleTestResetWorld(
  req: IncomingMessage,
  res: ServerResponse,
  nodeEnv: string,
  gameEngine: GameEngine
): void {
  if (!areTestHttpEndpointsEnabled(nodeEnv)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  if (!isLoopbackRequest(req)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    gameEngine.resetForTesting();
  } catch (error) {
    const failure =
      error instanceof AggregateError
        ? {
            message: error.message,
            failures: Array.from(error.errors, (entry: unknown) =>
              entry instanceof Error
                ? { message: entry.message, cause: entry.cause }
                : String(entry)
            ),
          }
        : error;
    logger.error('TEST_RESET_FAILED', {
      operation: 'reset test world',
      action: 'close or replace the failing player socket, then retry',
      error: failure,
    });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Test world reset failed' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'reset',
      world: gameEngine.getDiagnostics(),
      timestamp: new Date().toISOString(),
    })
  );
}

/** Place one live test pilot; gameplay still owns every resulting collision and action. */
export function handleTestPlacePlayer(
  req: IncomingMessage,
  res: ServerResponse,
  nodeEnv: string,
  gameEngine: GameEngine,
  wsCore: WebSocketCore
): void {
  if (!acceptTestPost(req, res, nodeEnv)) {
    return;
  }
  readBoundedTestJson(req, res, (parsed, respond) => {
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).some((key) => key !== 'playerId' && key !== 'position') ||
      typeof parsed['playerId'] !== 'string' ||
      parsed['playerId'].length === 0 ||
      Buffer.byteLength(parsed['playerId']) > 128 ||
      !isRecord(parsed['position']) ||
      Object.keys(parsed['position']).some((key) => key !== 'x' && key !== 'y')
    ) {
      respond(400, { error: 'Invalid fixture payload' });
      return;
    }
    const x = parsed['position']['x'];
    const y = parsed['position']['y'];
    if (
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      typeof y !== 'number' ||
      !Number.isFinite(y) ||
      Math.abs(x) > TEST_FIXTURE_MAX_COORDINATE ||
      Math.abs(y) > TEST_FIXTURE_MAX_COORDINATE
    ) {
      respond(400, { error: 'Invalid fixture position' });
      return;
    }
    const player = gameEngine.getPlayer(parsed['playerId']);
    if (!player || player.health <= 0 || player.exploding) {
      respond(404, { error: 'Live fixture player not found' });
      return;
    }

    const position = { x, y };
    const placed = gameEngine.playerMotion.placeActorForTesting(
      player.id,
      position,
      gameEngine.getServerTime()
    );
    if (!placed) {
      respond(409, { error: 'Fixture player motion state unavailable' });
      return;
    }
    gameEngine.ensureAsteroidField();
    wsCore.getBroadcaster().broadcastGameState();
    respond(200, {
      status: 'placed',
      playerId: player.id,
      position,
      ...(player.playerMotion ? { motionEpoch: player.playerMotion.epoch } : {}),
    });
  });
}

/** Arrange a safe crew scene; real inputs and the game loop must produce the outcome. */
export function handleTestArrangeCrewField(
  req: IncomingMessage,
  res: ServerResponse,
  nodeEnv: string,
  gameEngine: GameEngine,
  wsCore: WebSocketCore
): void {
  if (!acceptTestPost(req, res, nodeEnv)) {
    return;
  }
  readBoundedTestJson(req, res, (body, respond) => {
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== 'playerIds' && key !== 'scenario') ||
      !Array.isArray(body['playerIds']) ||
      body['playerIds'].length < 1 ||
      body['playerIds'].length > 4 ||
      !body['playerIds'].every(
        (id: unknown) => typeof id === 'string' && id.length > 0 && id.length < 128
      ) ||
      ![
        'delivery',
        'tow',
        'empty',
        'boundary',
        'impact',
        'mining',
        'cooperative',
        'reflection',
      ].includes(String(body['scenario']))
    ) {
      respond(400, { error: 'Invalid crew fixture' });
      return;
    }
    const ids = body['playerIds'] as string[];
    const players = ids.map((id) => gameEngine.getPlayer(id));
    if (
      new Set(ids).size !== ids.length ||
      players.some((player) => !player || player.exploding || player.health <= 0)
    ) {
      respond(404, { error: 'Live fixture crew unavailable' });
      return;
    }
    gameEngine.prepareDiagnosticWorld('traversal');
    const poses: { playerId: string; position: { x: number; y: number }; motionEpoch?: number }[] =
      [];
    for (const [index, player] of players.entries()) {
      if (!player) {
        throw new Error('Validated crew disappeared');
      }
      const position =
        body['scenario'] === 'boundary'
          ? { x: WORLD.radius - 500 + index * 120, y: 0 }
          : body['scenario'] === 'delivery' || body['scenario'] === 'tow'
            ? player.kitId === 'hauler'
              ? { x: 0, y: -360 }
              : { x: 220, y: -460 }
            : body['scenario'] === 'reflection'
              ? { x: -220, y: -460 }
              : { x: index * 120, y: -360 };
      if (
        !gameEngine.playerMotion.placeActorForTesting(
          player.id,
          position,
          gameEngine.getServerTime()
        )
      ) {
        respond(409, { error: 'Crew fixture motion unavailable' });
        return;
      }
      // 'tow' points the Hauler away from every furnace, so the cargo it hooks
      // stays hooked for as long as the scenario needs instead of being smelted.
      player.angle =
        body['scenario'] === 'reflection' || body['scenario'] === 'boundary'
          ? 0
          : body['scenario'] === 'tow'
            ? -Math.PI / 2
            : Math.PI / 2;
      player.spawnProtectionTimer =
        body['scenario'] === 'delivery' || body['scenario'] === 'tow' ? 600 : 0;
      if (body['scenario'] === 'impact' && index === 0) {
        player.health = DAMAGE.ASTEROID_COLLISION;
        player.healthRegenTimer = calculateHealthRegenDelayFrames();
      }
      player.abilityCooldownFrames = 0;
      poses.push({
        playerId: player.id,
        position,
        ...(player.playerMotion ? { motionEpoch: player.playerMotion.epoch } : {}),
      });
    }
    gameEngine.ensureAsteroidField();
    for (const rock of gameEngine.getAllAsteroids()) {
      gameEngine.removeAsteroid(rock.id);
    }
    gameEngine.parkSatellitePickups();
    const first = poses[0];
    if (body['scenario'] === 'reflection') {
      gameEngine.addAsteroid({
        id: 'crew-fixture-reflector',
        position: { x: 0, y: -460 },
        velocity: { x: 0, y: 0 },
        size: 32,
        health: 75,
        maxHealth: 75,
        material: 'metal',
        rotation: Math.PI / 2,
        angularVelocity: 0,
        jaggedness: 0.25,
        vertices: 4,
        offsets: [1, 1, 1, 1],
        phenomenon: {
          kind: 'reflective',
          clusterId: 'crew-fixture-reflector',
          energy: 0,
          maxEnergy: 6,
        },
      });
    } else if (body['scenario'] !== 'empty' && body['scenario'] !== 'boundary' && first) {
      gameEngine.addAsteroid({
        id: 'crew-fixture-ore',
        position:
          body['scenario'] === 'impact'
            ? { ...first.position }
            : body['scenario'] === 'tow'
              ? { x: 0, y: -260 }
              : { x: 0, y: -460 },
        velocity: { x: 0, y: 0 },
        size: body['scenario'] === 'cooperative' ? 50 : 25,
        health: body['scenario'] === 'mining' ? 25 : 75,
        maxHealth: body['scenario'] === 'mining' ? 25 : 75,
        material: ['mining', 'cooperative'].includes(String(body['scenario'])) ? 'ice' : 'metal',
        rotation: 0,
        angularVelocity: 0,
        jaggedness: 0.25,
        vertices: 4,
        offsets: [1, 1, 1, 1],
      });
    }
    wsCore.getBroadcaster().broadcastGameState();
    respond(200, {
      status: 'arranged',
      poses,
      asteroidId:
        body['scenario'] === 'empty' || body['scenario'] === 'boundary'
          ? null
          : body['scenario'] === 'reflection'
            ? 'crew-fixture-reflector'
            : 'crew-fixture-ore',
    });
  });
}
