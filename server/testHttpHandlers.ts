import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';
import type { WebSocket } from 'ws';
import { logger } from '../setup/serverLogger';
import { beltAsteroid, beltSlotPosition } from '../shared/asteroidBelt';
import { ASTEROID_INTERACTIONS, layoutReflectiveCluster } from '../shared/asteroidPhenomena';
import { calculateHealthRegenDelayFrames } from '../shared/constants/health';
import { cargoCapacity } from '../shared/economy';
import { EQUIPMENT_IDS } from '../shared/equipment';
import { civicLot, TOWN_HEARTH } from '../shared/furnaces';
import { storeOffer } from '../shared/townStore';
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
    res.end(
      JSON.stringify({
        error: 'Test world reset failed',
        reason: error instanceof AggregateError ? 'socket-close-failed' : 'world-reset-failed',
      })
    );
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

/** Detached, credential-free observations for local fixture completion and failure evidence. */
export function handleTestFixtureState(
  req: IncomingMessage,
  res: ServerResponse,
  nodeEnv: string,
  gameEngine: GameEngine,
  sockets: ReadonlySet<WebSocket>
): void {
  if (!acceptTestPost(req, res, nodeEnv)) {
    return;
  }
  readBoundedTestJson(req, res, (body, respond) => {
    const asteroidIds =
      isRecord(body) && body['asteroidIds'] !== undefined ? body['asteroidIds'] : [];
    if (
      !Array.isArray(asteroidIds) ||
      asteroidIds.length > 30 ||
      !asteroidIds.every((id) => typeof id === 'string' && id.length < 128)
    ) {
      respond(400, { error: 'Invalid fixture asteroid IDs' });
      return;
    }
    const observePlayerShots = isRecord(body) ? body['observePlayerShots'] : undefined;
    if (observePlayerShots !== undefined) {
      if (
        !Array.isArray(observePlayerShots) ||
        observePlayerShots.length > 4 ||
        !observePlayerShots.every(
          (id) => typeof id === 'string' && id.length > 0 && id.length < 128
        )
      ) {
        respond(400, { error: 'Invalid fixture shot owners' });
        return;
      }
      gameEngine.observeFixtureShots(nodeEnv, observePlayerShots);
    }
    respond(200, {
      combat: gameEngine.getFixtureCombatEvidence(),
      spiderField: {
        ...gameEngine.getSpiderField(),
        spiders: gameEngine.getSpiderField().spiders.map((spider) => ({
          ...spider,
          towedBy:
            gameEngine.getAllPlayers().find((player) => player.harpoonTargetId === spider.id)?.id ??
            null,
        })),
      },
      crawlers: gameEngine
        .getSpiderField()
        .spiders.filter((spider) => spider.crawler && asteroidIds.includes(spider.crawler.hostId)),
      observedRocks: asteroidIds.flatMap((id: string) => {
        const rock = gameEngine.getAsteroid(id);
        return rock ? [rock] : [];
      }),
      world: gameEngine.getDiagnostics(),
      seed: gameEngine.getWorldSeedForTesting(),
      controlledRocks: ['crew-fixture-shared-stationary', 'crew-fixture-shared-moving'].flatMap(
        (id) => {
          const rock = gameEngine.getAsteroid(id);
          return rock
            ? [{ id, position: { ...rock.position }, velocity: { ...rock.velocity } }]
            : [];
        }
      ),
      sockets: {
        total: sockets.size,
        open: [...sockets].filter((socket) => socket.readyState === socket.OPEN).length,
      },
      players: gameEngine.getAllPlayers().map((player) => ({
        id: player.id,
        cargo: player.cargo,
        score: player.score,
        kitId: player.kitId,
        harpoonTargetId: player.harpoonTargetId ?? null,
        haulerUtility: player.haulerUtility ?? null,
        abilityCooldownFrames: player.abilityCooldownFrames ?? 0,
        health: player.health,
        exploding: player.exploding,
        position: { ...player.position },
        velocity: { ...player.velocity },
        socketState: player.ws?.readyState ?? null,
        motionEpoch: player.playerMotion?.epoch ?? null,
        furnaceTransit: player.furnaceTransit ?? null,
        spawnProtectionTimer: player.spawnProtectionTimer ?? 0,
      })),
    });
  });
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
      Object.keys(parsed).some(
        (key) =>
          ![
            'playerId',
            'position',
            'clearSpawnProtection',
            'expectedTowTargetId',
            'atTowTarget',
          ].includes(key)
      ) ||
      ('clearSpawnProtection' in parsed && typeof parsed['clearSpawnProtection'] !== 'boolean') ||
      ('atTowTarget' in parsed && typeof parsed['atTowTarget'] !== 'boolean') ||
      (parsed['atTowTarget'] === true && typeof parsed['expectedTowTargetId'] !== 'string') ||
      ('expectedTowTargetId' in parsed &&
        (typeof parsed['expectedTowTargetId'] !== 'string' ||
          parsed['expectedTowTargetId'].length === 0 ||
          Buffer.byteLength(parsed['expectedTowTargetId']) > 128)) ||
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
    if (
      !player ||
      player.health <= 0 ||
      player.exploding ||
      !player.ws ||
      player.ws.readyState !== player.ws.OPEN
    ) {
      respond(404, {
        error: 'Live fixture player not found',
        reason: !player
          ? 'missing'
          : player.health <= 0 || player.exploding
            ? 'dead'
            : 'transport-closed',
        health: player?.health ?? null,
        exploding: player?.exploding ?? null,
        socketState: player?.ws?.readyState ?? null,
        motionEpoch: player?.playerMotion?.epoch ?? null,
      });
      return;
    }

    const expectedTowTargetId = parsed['expectedTowTargetId'];
    const towOwners =
      typeof expectedTowTargetId === 'string'
        ? gameEngine
            .getAllPlayers()
            .filter(
              (actor) =>
                actor.harpoonTargetId === expectedTowTargetId &&
                gameEngine.playerMotion.hasLiveTowForTesting(actor, expectedTowTargetId)
            )
        : [];
    const towOwner = towOwners.length === 1 ? towOwners[0] : undefined;
    const towTarget =
      typeof expectedTowTargetId === 'string'
        ? gameEngine
            .getSpiderField()
            .spiders.find(
              (spider) => spider.id === expectedTowTargetId && spider.health > 0 && !spider.crawler
            )
        : undefined;
    if (
      (expectedTowTargetId !== undefined &&
        (!gameEngine.playerMotion.hasLiveActorForTesting(player) ||
          !towOwner ||
          !towTarget ||
          (player.id !== towOwner.id && Boolean(player.harpoonTargetId)))) ||
      (parsed['clearSpawnProtection'] === true &&
        player.harpoonTargetId &&
        expectedTowTargetId === undefined)
    ) {
      respond(409, { error: 'Validated live terrain tow required' });
      return;
    }
    // Resolve moving-target placement inside the same validated request as release.
    const position =
      parsed['atTowTarget'] === true && towTarget ? { ...towTarget.position } : { x, y };
    const placed =
      towOwner?.id === player.id && typeof expectedTowTargetId === 'string'
        ? gameEngine.playerMotion.placeTowedActorForTesting(
            player,
            position,
            gameEngine.getServerTime(),
            expectedTowTargetId
          )
        : gameEngine.playerMotion.placeActorForTesting(
            player.id,
            position,
            gameEngine.getServerTime()
          );
    if (!placed) {
      respond(409, { error: 'Fixture player motion state unavailable' });
      return;
    }
    if (parsed['clearSpawnProtection'] === true) {
      player.spawnProtectionTimer = 0;
    }
    gameEngine.ensureAsteroidField();
    wsCore.getBroadcaster().broadcastGameState();
    respond(200, {
      expectedTowTargetId: expectedTowTargetId ?? null,
      atTowTarget: parsed['atTowTarget'] === true,
      towOwnerId: towOwner?.id ?? null,
      towTargetId: towOwner?.harpoonTargetId ?? null,
      placedActorTowTargetId: player.harpoonTargetId ?? null,
      spawnProtectionCleared: parsed['clearSpawnProtection'] === true,
      spawnProtectionTimer: player.spawnProtectionTimer ?? 0,
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
        'equipment',
        'boundary',
        'impact',
        'mining',
        'cooperative',
        'reflection',
        'satellite',
        'probe',
        'spider-nest',
        'spider-tools',
        'spider-rescue',
        'spider-tow-bite',
        'pinball',
        'shared-field',
        'belt-mining',
        'belt-escape',
        'belt-pursuit',
        'map-icons',
        'furnace',
        'town-store',
        'street-build',
        'street-escape',
        'street-travel',
        'furnace-build',
        'cargo',
        'full-cargo',
        'settlement-delivery',
      ].includes(String(body['scenario']))
    ) {
      respond(400, { error: 'Invalid crew fixture' });
      return;
    }
    const spiderWorks = TOWN_HEARTH;
    const furnaceLot = civicLot('street-1-0');
    if (!furnaceLot) {
      throw new Error('Furnace build fixture is missing its lot');
    }
    const ids = body['playerIds'] as string[];
    const players = ids.map((id) => gameEngine.getPlayer(id));
    if (
      new Set(ids).size !== ids.length ||
      players.some(
        (player) =>
          !player ||
          player.exploding ||
          player.health <= 0 ||
          !player.ws ||
          player.ws.readyState !== player.ws.OPEN
      )
    ) {
      respond(404, { error: 'Live fixture crew unavailable' });
      return;
    }
    if (players.some((player) => !player || !gameEngine.playerMotion.getState(player.id))) {
      respond(409, { error: 'Crew fixture motion unavailable' });
      return;
    }
    const playersBefore = players.map((player) => {
      if (!player) {
        throw new Error('Validated crew disappeared');
      }
      return { id: player.id, cargo: player.cargo, score: player.score, kitId: player.kitId };
    });
    gameEngine.prepareDiagnosticWorld('traversal');
    const poses: { playerId: string; position: { x: number; y: number }; motionEpoch?: number }[] =
      [];
    for (const [index, player] of players.entries()) {
      if (!player) {
        throw new Error('Validated crew disappeared');
      }
      const position =
        body['scenario'] === 'pinball'
          ? { x: Math.cos((Math.PI * 3) / 10) * 300, y: -1500 + Math.sin((Math.PI * 3) / 10) * 300 }
          : body['scenario'] === 'shared-field'
            ? { x: 20_120, y: (index - (players.length - 1) / 2) * 120 }
            : body['scenario'] === 'belt-mining'
              ? { x: beltSlotPosition(60).x - 450, y: beltSlotPosition(60).y + index * 150 }
              : body['scenario'] === 'town-store'
                ? { x: 0, y: 0 }
                : ['furnace-build', 'street-escape', 'street-travel'].includes(
                      String(body['scenario'])
                    )
                  ? { ...furnaceLot.position }
                  : body['scenario'] === 'spider-tow-bite'
                    ? { x: 4400, y: 2200 + index * 600 }
                    : body['scenario'] === 'spider-rescue'
                      ? { x: 4400 + index * 120, y: 2200 }
                      : body['scenario'] === 'spider-tools'
                        ? {
                            x: spiderWorks.position.x + 800 + index * 120,
                            y: spiderWorks.position.y,
                          }
                        : ['spider-nest', 'map-icons', 'furnace'].includes(String(body['scenario']))
                          ? { x: 3000 + index * 120, y: 5000 }
                          : body['scenario'] === 'boundary'
                            ? { x: WORLD.radius - 500 + index * 120, y: 0 }
                            : body['scenario'] === 'delivery'
                              ? player.kitId === 'hauler'
                                ? { x: 0, y: 550 }
                                : { x: 220, y: 460 }
                              : body['scenario'] === 'tow'
                                ? player.kitId === 'hauler'
                                  ? { x: 0, y: -500 }
                                  : { x: 220, y: -460 }
                                : body['scenario'] === 'reflection' || body['scenario'] === 'probe'
                                  ? {
                                      x: -220,
                                      y: -460 + (body['scenario'] === 'probe' ? index * 160 : 0),
                                    }
                                  : { x: index * 120, y: -500 };
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
      // Delivery faces screen-up, which decreases world y, from the positive-y
      // approach into Town Square. Tow uses that same heading from the
      // negative-y side so the hooked rock moves farther from the hearth.
      player.angle = ['spider-tools'].includes(String(body['scenario']))
        ? Math.PI
        : body['scenario'] === 'reflection' ||
            body['scenario'] === 'probe' ||
            body['scenario'] === 'boundary' ||
            body['scenario'] === 'spider-rescue' ||
            body['scenario'] === 'spider-tow-bite'
          ? 0
          : Math.PI / 2;
      player.spawnProtectionTimer = [
        'delivery',
        'tow',
        'map-icons',
        'spider-tools',
        'spider-rescue',
        'spider-tow-bite',
        'belt-mining',
        'belt-escape',
        'belt-pursuit',
        'furnace',
        'town-store',
        'furnace-build',
      ].includes(String(body['scenario']))
        ? 600
        : 0;
      if (body['scenario'] === 'impact' && index === 0) {
        player.health = DAMAGE.ASTEROID_COLLISION;
        player.healthRegenTimer = calculateHealthRegenDelayFrames();
      }
      if (body['scenario'] === 'tow') {
        player.health = player.maxHealth;
        player.healthRegenTimer = calculateHealthRegenDelayFrames();
      }
      if (body['scenario'] !== 'spider-tow-bite') {
        player.abilityCooldownFrames = 0;
      }
      if (body['scenario'] === 'delivery') {
        player.cargo = 0;
      }
      if (body['scenario'] === 'full-cargo') {
        player.cargo = cargoCapacity(player.kitId);
      }
      if (body['scenario'] === 'cargo') {
        player.cargo = index === 0 ? 400 : 0;
        player.score = 300;
      }
      if (body['scenario'] === 'furnace-build') {
        player.score = furnaceLot.cost;
      }
      if (['street-escape', 'street-travel'].includes(String(body['scenario']))) {
        player.score = furnaceLot.cost + (body['scenario'] === 'street-travel' ? 250 : 0);
      }
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
    if (body['scenario'] !== 'satellite') {
      gameEngine.parkSatellitePickups();
    }
    const first = poses[0];
    if (body['scenario'] === 'pinball') {
      for (const [index, placement] of layoutReflectiveCluster({ x: 0, y: -1500 }).entries()) {
        gameEngine.addAsteroid({
          id: `crew-fixture-pinball-${index}`,
          position: placement.position,
          velocity: { x: 0, y: 0 },
          size: ASTEROID_INTERACTIONS.reflectiveSize,
          health: 75,
          maxHealth: 75,
          material: 'metal',
          rotation: placement.rotation,
          angularVelocity: 0,
          jaggedness: 0.25,
          vertices: 6,
          offsets: [1, 0.8, 1, 1, 0.8, 1],
          phenomenon: {
            kind: 'reflective',
            clusterId: 'crew-fixture-pinball-0',
            energy: 0,
            maxEnergy: ASTEROID_INTERACTIONS.reflectiveEnergy,
          },
        });
      }
    }
    if (body['scenario'] === 'shared-field') {
      gameEngine.clearSpiderField();
      for (const moving of [false, true]) {
        gameEngine.addAsteroid({
          id: moving ? 'crew-fixture-shared-moving' : 'crew-fixture-shared-stationary',
          position: { x: 20_000, y: moving ? 350 : 0 },
          velocity: { x: moving ? 0.25 : 0, y: 0 },
          angularVelocity: moving ? 0.005 : 0,
          size: 25,
          health: 75,
          maxHealth: 75,
          material: 'metal',
          rotation: 0,
          jaggedness: 0.25,
          vertices: 6,
          offsets: [1, 0.8, 1, 0.9, 1, 0.8],
        });
      }
    }
    if (body['scenario'] === 'belt-mining') {
      gameEngine.clearSpiderField();
      gameEngine.addAsteroid(beltAsteroid(gameEngine.getWorldSeedForTesting(), 60, 0));
    }
    if (body['scenario'] === 'equipment' && first) {
      for (const [index, equipment] of EQUIPMENT_IDS.entries()) {
        gameEngine.dropEquipmentAt(
          { x: first.position.x + 220 + index * 150, y: first.position.y },
          equipment
        );
      }
    }
    if (body['scenario'] === 'street-escape') {
      gameEngine.clearSpiderField();
      if (
        !gameEngine.spawnTerrainSpider({ x: furnaceLot.position.x + 200, y: furnaceLot.position.y })
      ) {
        throw new Error('Could not spawn chasing spider');
      }
    }
    if (body['scenario'] === 'spider-tow-bite') {
      gameEngine.clearSpiderField();
      if (!gameEngine.spawnTerrainSpider({ x: 4580, y: 2200 })) {
        throw new Error('Spider bite fixture could not spawn its captive');
      }
    } else if (body['scenario'] === 'spider-rescue') {
      gameEngine.clearSpiderField();
      if (
        !gameEngine.spawnTerrainSpider({ x: 4580, y: 2200 }) ||
        !gameEngine.spawnTerrainSpider({ x: 4490, y: 2600 })
      ) {
        throw new Error('Spider rescue fixture could not spawn its spiders');
      }
    } else if (body['scenario'] === 'belt-escape' || body['scenario'] === 'belt-pursuit') {
      gameEngine.clearSpiderField();
      for (const [id, x, health] of [
        ['belt-1-0-0', 0, body['scenario'] === 'belt-escape' ? 25 : 150],
        ['crew-fixture-escape-destination', 180, 150],
      ] as const) {
        gameEngine.addAsteroid({
          id,
          position: { x, y: -620 },
          velocity: { x: 0, y: 0 },
          size: 55,
          health,
          maxHealth: 150,
          material: 'metal',
          rotation: 0,
          angularVelocity: 0,
          jaggedness: 0,
          vertices: 4,
          offsets: [1, 1, 1, 1],
        });
      }
      if (body['scenario'] === 'belt-pursuit') {
        gameEngine.addAsteroid({
          id: 'crew-fixture-pursuit-destination',
          position: { x: 360, y: -620 },
          velocity: { x: 0, y: 0 },
          size: 55,
          health: 150,
          maxHealth: 150,
          material: 'metal',
          rotation: 0,
          angularVelocity: 0,
          jaggedness: 0,
          vertices: 4,
          offsets: [1, 1, 1, 1],
        });
      }
    } else if (body['scenario'] === 'spider-tools') {
      gameEngine.clearSpiderField();
      if (
        !gameEngine.spawnTerrainSpider({
          x: spiderWorks.position.x + 980,
          y: spiderWorks.position.y,
        })
      ) {
        throw new Error('Spider tool fixture could not spawn its target');
      }
    } else if (['spider-nest', 'map-icons'].includes(String(body['scenario']))) {
      gameEngine.addAsteroid({
        id: 'crew-fixture-spider-deposit',
        position: { x: 5000, y: 5000 },
        velocity: { x: 0, y: 0 },
        size: 50,
        health: 500,
        maxHealth: 500,
        material: 'metal',
        rotation: 0,
        angularVelocity: 0,
        jaggedness: 0.25,
        vertices: 4,
        offsets: [1, 1, 1, 1],
      });
    } else if (body['scenario'] === 'probe') {
      gameEngine.addAsteroid({
        id: 'crew-fixture-probe-host',
        position: { x: -20, y: -460 },
        velocity: { x: 0.12, y: 0 },
        size: 50,
        health: 500,
        maxHealth: 500,
        material: 'metal',
        rotation: 0,
        angularVelocity: 0.001,
        jaggedness: 0.25,
        vertices: 4,
        offsets: [1, 1, 1, 1],
      });
      gameEngine.addAsteroid({
        id: 'crew-fixture-probe-deposit',
        position: { x: 60, y: -610 },
        velocity: { x: 0, y: 0 },
        size: 30,
        health: 300,
        maxHealth: 300,
        material: 'ice',
        rotation: 0,
        angularVelocity: 0,
        jaggedness: 0.25,
        vertices: 4,
        offsets: [1, 1, 1, 1],
      });
    } else if (body['scenario'] === 'reflection') {
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
    } else if (body['scenario'] === 'town-store') {
      const paint = storeOffer('placeholder-1');
      if (!paint) {
        throw new Error('Town store fixture is missing Ember paint');
      }
      for (const player of players) {
        if (player) {
          player.score = paint.cost * 2;
        }
      }
    } else if (body['scenario'] === 'settlement-delivery' && first) {
      for (const [ore, size] of [
        ['ice', 50],
        ['metal', 65],
        ['rubble', 75],
        ['crystal', 36],
      ] as const) {
        gameEngine.addAsteroid({
          id: `settlement-${ore}`,
          material: ore,
          ore,
          size,
          position: { x: 0, y: 0 },
          velocity: { x: 0, y: 0 },
          health: 100,
          maxHealth: 100,
          rotation: 0,
          angularVelocity: 0,
          jaggedness: 0,
          vertices: 4,
          offsets: [1, 1, 1, 1],
          boost: { phase: 'burning', ownerId: first.playerId, angle: 0 },
        });
      }
    } else if (
      ![
        'empty',
        'boundary',
        'satellite',
        'cargo',
        'pinball',
        'shared-field',
        'belt-mining',
        'street-travel',
        'furnace-build',
      ].includes(String(body['scenario'])) &&
      first
    ) {
      gameEngine.addAsteroid({
        id: 'crew-fixture-ore',
        position:
          body['scenario'] === 'impact'
            ? { ...first.position }
            : body['scenario'] === 'tow'
              ? { x: 0, y: -260 }
              : body['scenario'] === 'delivery'
                ? { x: 0, y: 460 }
                : // Default crew poses sit at y=-500; keep the rock clear of that hull
                  // and outside TOWN_STORE_RADIUS so ability chrome stays kit-native.
                  { x: 0, y: -620 },
        velocity: { x: 0, y: 0 },
        size: body['scenario'] === 'cooperative' ? 50 : 25,
        health: ['mining', 'full-cargo'].includes(String(body['scenario'])) ? 25 : 75,
        maxHealth: ['mining', 'full-cargo'].includes(String(body['scenario'])) ? 25 : 75,
        ore: 'metal',
        material: ['mining', 'full-cargo', 'cooperative'].includes(String(body['scenario']))
          ? 'ice'
          : 'metal',
        rotation: 0,
        angularVelocity: 0,
        jaggedness: 0.25,
        vertices: 4,
        offsets: [1, 1, 1, 1],
      });
    }
    if (body['scenario'] === 'map-icons') {
      for (const [index, material] of (['ice', 'rubble'] as const).entries()) {
        gameEngine.addAsteroid({
          id: `crew-fixture-map-${material}`,
          position: { x: 4350 + index * 450, y: 4650 },
          velocity: { x: 0, y: 0 },
          size: 25,
          health: 500,
          maxHealth: 500,
          material,
          rotation: 0,
          angularVelocity: 0,
          jaggedness: 0.25,
          vertices: 7,
          offsets: [1, 0.8, 1, 0.75, 1, 0.9, 1],
        });
      }
      gameEngine.parkSatellitePickups({ x: 4300, y: 5300 });
    }
    wsCore.getBroadcaster().broadcastGameState();
    respond(200, {
      status: 'arranged',
      playersBefore,
      playersAfter: players.map((player) => {
        if (!player) {
          throw new Error('Validated crew disappeared');
        }
        return { id: player.id, cargo: player.cargo, score: player.score, kitId: player.kitId };
      }),
      poses,
      ...(body['scenario'] === 'shared-field'
        ? { asteroidIds: ['crew-fixture-shared-stationary', 'crew-fixture-shared-moving'] }
        : {}),
      asteroidId:
        body['scenario'] === 'belt-mining'
          ? beltAsteroid(gameEngine.getWorldSeedForTesting(), 60, 0).id
          : body['scenario'] === 'shared-field'
            ? 'crew-fixture-shared-stationary'
            : ['empty', 'boundary', 'satellite'].includes(String(body['scenario']))
              ? null
              : ['spider-nest', 'map-icons'].includes(String(body['scenario']))
                ? 'crew-fixture-spider-deposit'
                : body['scenario'] === 'reflection'
                  ? 'crew-fixture-reflector'
                  : 'crew-fixture-ore',
    });
  });
}
