import type { IncomingMessage, ServerResponse } from 'node:http';
import { segmentCircleContact } from '../shared/asteroidPhenomena';
import { GROWTH, radiusFromMass } from '../shared/shipGrowth';
import type { Position } from '../shared-types';
import { canDealCombatDamage } from '../src/entities/player/softFactions';
import type { WebSocketCore } from './communication/WebSocketCore';
import type { GameEntity } from './core/EntityManager';
import type { GameEngine } from './core/GameEngine';
import { SERVER_RELEASE_ID } from './release';

const TEST_FIXTURE_MAX_BYTES = 1024;
const TEST_FIXTURE_MAX_COORDINATE = 10_000;
const TEST_FIXTURE_BODY_TIMEOUT_MS = 2000;
const BOT_DUEL_TARGET_RADIUS = 820;
const BOT_DUEL_LANE_COUNT = 24;
const BOT_DUEL_MIN_DISTANCE = 80;
const BOT_DUEL_CLEARANCE = 16;

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

function findBotDuelLane(
  gameEngine: GameEngine,
  player: GameEntity,
  bot: GameEntity
): { playerPosition: Position; botPosition: Position } | undefined {
  const playerRadius = radiusFromMass(player.mass ?? GROWTH.BASE_MASS);
  const botRadius = radiusFromMass(bot.mass ?? GROWTH.BASE_MASS);
  const distance = Math.max(BOT_DUEL_MIN_DISTANCE, playerRadius + botRadius + 40);
  const obstacles = [
    ...gameEngine
      .getAllAsteroids()
      .map((asteroid) => ({ position: asteroid.position, radius: asteroid.size })),
    ...gameEngine.entityManager
      .getAllEntities()
      .filter(
        (entity) =>
          entity.id !== player.id &&
          entity.id !== bot.id &&
          entity.health > 0 &&
          !entity.exploding &&
          entity.respawnTimer === undefined
      )
      .map((entity) => ({
        position: entity.position,
        radius: radiusFromMass(entity.mass ?? GROWTH.BASE_MASS),
      })),
    ...gameEngine
      .getAllSatellites()
      .filter((satellite) => satellite.health > 0 && !satellite.exploding)
      .map((satellite) => ({ position: satellite.position, radius: satellite.radius })),
    ...gameEngine.getLoot().map((loot) => ({ position: loot.position, radius: loot.radius })),
  ];

  for (let index = 0; index < BOT_DUEL_LANE_COUNT; index++) {
    const angle = (index * Math.PI * 2) / BOT_DUEL_LANE_COUNT;
    const outward = { x: Math.cos(angle), y: Math.sin(angle) };
    const botPosition = {
      x: outward.x * BOT_DUEL_TARGET_RADIUS,
      y: outward.y * BOT_DUEL_TARGET_RADIUS,
    };
    const playerPosition = {
      x: botPosition.x + outward.x * distance,
      y: botPosition.y + outward.y * distance,
    };
    const laneRadius = Math.max(playerRadius, botRadius) + BOT_DUEL_CLEARANCE;
    if (
      obstacles.every(
        (obstacle) =>
          segmentCircleContact(
            playerPosition,
            botPosition,
            obstacle.position,
            obstacle.radius + laneRadius
          ) === undefined
      )
    ) {
      return { playerPosition, botPosition };
    }
  }
  return undefined;
}

/** Test-only HTTP routes — enabled only in local dev and Vitest, never in production. */
export function areTestHttpEndpointsEnabled(nodeEnv: string): boolean {
  return nodeEnv === 'test' || nodeEnv === 'development';
}

export function buildHealthPayload(
  wsCore: WebSocketCore,
  gameEngine: GameEngine,
  logging?: Record<string, unknown>
): Record<string, unknown> {
  const diagnostics = gameEngine.getDiagnostics();
  return {
    status: 'healthy',
    releaseId: SERVER_RELEASE_ID,
    timestamp: new Date().toISOString(),
    players: wsCore.getPlayerCount(),
    uptime: process.uptime(),
    world: diagnostics,
    ...(logging ? { logging } : {}),
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

  gameEngine.resetForTesting();
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
    if (player?.type !== 'human' || player.health <= 0 || player.exploding) {
      respond(404, { error: 'Live fixture player not found' });
      return;
    }

    const position = { x, y };
    const placed =
      player.asteroidInteractions === 1
        ? gameEngine.asteroidMotion.placeActorForTesting(player.id, position, Date.now())
        : gameEngine.updatePlayer(player.id, {
            position,
            velocity: { x: 0, y: 0 },
            thrusting: false,
          }) !== undefined;
    if (!placed) {
      respond(409, { error: 'Fixture player motion state unavailable' });
      return;
    }
    wsCore.getBroadcaster().broadcastGameState();
    respond(200, {
      status: 'placed',
      playerId: player.id,
      position,
      ...(player.asteroidMotion ? { motionEpoch: player.asteroidMotion.epoch } : {}),
    });
  });
}

/** Arrange a real human and hostile bot for one short, unobstructed laser shot. */
export function handleTestArrangeBotShot(
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
      Object.keys(parsed).some((key) => key !== 'playerId' && key !== 'botId') ||
      typeof parsed['playerId'] !== 'string' ||
      parsed['playerId'].length === 0 ||
      Buffer.byteLength(parsed['playerId']) > 128 ||
      typeof parsed['botId'] !== 'string' ||
      parsed['botId'].length === 0 ||
      Buffer.byteLength(parsed['botId']) > 128
    ) {
      respond(400, { error: 'Invalid fixture payload' });
      return;
    }

    const player = gameEngine.getPlayer(parsed['playerId']);
    const bot = gameEngine.getPlayer(parsed['botId']);
    if (
      player?.type !== 'human' ||
      player.health <= 0 ||
      player.exploding ||
      player.respawnTimer !== undefined
    ) {
      respond(404, { error: 'Live fixture player not found' });
      return;
    }
    if (bot?.type !== 'bot' || bot.health <= 0 || bot.exploding || bot.respawnTimer !== undefined) {
      respond(404, { error: 'Live fixture bot not found' });
      return;
    }
    if (!canDealCombatDamage(player.factionId, bot.factionId)) {
      respond(409, { error: 'Fixture bot is not hostile to player' });
      return;
    }
    if (bot.shieldActive || (bot.shieldTime ?? 0) > 0) {
      respond(409, { error: 'Fixture bot shield is active' });
      return;
    }

    const lane = findBotDuelLane(gameEngine, player, bot);
    if (!lane) {
      respond(409, { error: 'No clear fixture firing lane' });
      return;
    }
    const playerPlaced =
      player.asteroidInteractions === 1
        ? gameEngine.asteroidMotion.placeActorForTesting(player.id, lane.playerPosition, Date.now())
        : gameEngine.updatePlayer(player.id, {
            position: lane.playerPosition,
            velocity: { x: 0, y: 0 },
            thrusting: false,
          }) !== undefined;
    if (!playerPlaced) {
      respond(409, { error: 'Fixture player motion state unavailable' });
      return;
    }
    const placedBot = gameEngine.updatePlayer(bot.id, {
      position: lane.botPosition,
      velocity: { x: 0, y: 0 },
      thrusting: false,
    });
    if (!placedBot) {
      respond(409, { error: 'Fixture bot motion state unavailable' });
      return;
    }

    wsCore.getBroadcaster().broadcastGameState();
    respond(200, {
      status: 'arranged',
      playerId: player.id,
      botId: bot.id,
      playerPosition: lane.playerPosition,
      botPosition: lane.botPosition,
      botHealth: bot.health,
      ...(player.asteroidMotion ? { motionEpoch: player.asteroidMotion.epoch } : {}),
    });
  });
}
