import { afterEach, assert, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';
import { ROID, SATELLITE } from '../../../src/constants';
import { snapshotFixture } from '../../unit/network/snapshotFixture';

type ReceivedMessage = Record<string, unknown> & { type: string; data?: unknown };

interface PilotResult<TState> {
  socket: WebSocket;
  messages: ReceivedMessage[];
  errors: unknown[];
  state: () => TState | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReceivedMessage(value: unknown): value is ReceivedMessage {
  return isRecord(value) && typeof value['type'] === 'string';
}

function parseReceivedMessage(raw: WebSocket.RawData): ReceivedMessage {
  const parsed: unknown = JSON.parse(raw.toString());
  if (!isReceivedMessage(parsed)) {
    throw new Error('Server message is missing its type');
  }
  return parsed;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test('real legacy and negotiated sockets render matching worlds across late join and reconnect', async () => {
  const engine = new GameEngine(731);
  const broadcaster = new GameStateBroadcaster(engine);
  const handler = new MessageHandler(engine, broadcaster);
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const clients: WebSocket[] = [];
  cleanup = async () => {
    for (const client of clients) {
      client.terminate();
    }
    for (const client of wss.clients) {
      client.terminate();
    }
    engine.stopGameLoop();
    broadcaster.stopPeriodicBroadcast();
    await new Promise<void>((resolve, reject) =>
      wss.close((error) => (error ? reject(error) : resolve()))
    );
  };
  wss.on('connection', (socket) => {
    socket.on('message', (text) => {
      const message: unknown = JSON.parse(text.toString());
      handler.handleMessage(message, socket);
    });
    socket.on('close', () => {
      const player = engine.getPlayerBySocket(socket);
      if (player) {
        engine.removePlayer(player.id);
      }
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', resolve));
  const address = wss.address();
  if (!address || typeof address === 'string') {
    throw new Error('No test port');
  }
  const port = address.port;

  async function pilot(id: string, negotiate: true): Promise<PilotResult<ServerGameSnapshot>>;
  async function pilot(id: string, negotiate: false): Promise<PilotResult<unknown>>;
  async function pilot(
    id: string,
    negotiate: boolean
  ): Promise<PilotResult<ServerGameSnapshot> | PilotResult<unknown>> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(socket);
    const decoder = new SnapshotDecoder();
    const messages: ReceivedMessage[] = [];
    let modernState: ServerGameSnapshot | undefined;
    let legacyState: unknown;
    const errors: unknown[] = [];
    socket.on('message', (text) => {
      try {
        const message = parseReceivedMessage(text);
        messages.push(message);
        if (message.type === 'snapshot') {
          modernState = decoder.decode(message.data);
        }
        if (message.type === 'gameState') {
          legacyState = message.data;
        }
      } catch (error) {
        errors.push(error);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'join',
        data: {
          id,
          name: id,
          position: { x: 100, y: 100 },
          ...(negotiate ? { snapshotVersion: 1 } : {}),
        },
      })
    );
    if (negotiate) {
      await expect.poll(() => modernState).toBeDefined();
      return { socket, messages, errors, state: () => modernState };
    }
    await expect.poll(() => legacyState).toBeDefined();
    return { socket, messages, errors, state: () => legacyState };
  }

  const old = await pilot('legacy', false);
  const modern = await pilot('new', true);
  // Seed a real active shot and a normal large ice rock's cooperative window.
  // These must survive reconnect even when the one-shot event was missed.
  const satellite = engine.getAllSatellites()[0];
  assert.exists(satellite);
  const legacyPlayer = engine.getPlayer('legacy');
  assert.exists(legacyPlayer);
  legacyPlayer.position = { x: satellite.position.x + 180, y: satellite.position.y };
  for (let frame = 0; frame < 240 && engine.getActiveSatelliteProjectiles().length === 0; frame++) {
    engine.tickSatellites();
  }
  expect(engine.getActiveSatelliteProjectiles().length).toBeGreaterThan(0);
  const fixtureAsteroid = snapshotFixture().asteroids[0];
  assert.exists(fixtureAsteroid);
  const rock = {
    ...fixtureAsteroid,
    id: 'recoverable-ice',
    material: 'ice' as const,
    size: ROID.COLLAB_SPLIT_MIN_SIZE,
    isCollabTarget: false,
  };
  engine.addAsteroid(rock);
  expect(engine.handleAsteroidHit(rock.id, 'legacy').outcome).toBe('tagged');
  expect(engine.getActiveCollabTags().map((tag) => tag.asteroidId)).toContain(rock.id);
  const newPlayer = engine.getPlayer('new');
  assert.exists(newPlayer);
  for (let tick = 0; tick < 8; tick++) {
    newPlayer.position.x += 4;
    broadcaster.broadcastGameState();
    const expected: unknown = JSON.parse(JSON.stringify(engine.getGameState()));
    const complete: ServerGameSnapshot = {
      ...engine.getGameState(),
      playerProjectiles: engine.getPlayerProjectiles(),
      satelliteProjectiles: engine
        .getActiveSatelliteProjectiles()
        .map((shot) => ({ id: shot.shotId, ...shot })),
      collabTags: engine.getActiveCollabTags().map((tag) => ({ id: tag.asteroidId, ...tag })),
    };
    await expect.poll(() => modern.state()).toEqual(complete);
    await expect.poll(() => old.state()).toEqual(expected);
  }
  expect(old.messages.some((message) => message.type === 'snapshot')).toBe(false);
  expect(old.state()).not.toHaveProperty('satelliteProjectiles');
  expect(old.state()).not.toHaveProperty('collabTags');
  expect(modern.errors).toEqual([]);
  modern.socket.close();
  await expect.poll(() => engine.getPlayer('new')).toBeUndefined();
  const reconnected = await pilot('new', true);
  const recovered = reconnected.state();
  assert.exists(recovered);
  expect(recovered.satelliteProjectiles.length).toBeGreaterThan(0);
  expect(recovered.collabTags.map((tag) => tag.asteroidId)).toContain(rock.id);
  const initialSnapshot = reconnected.messages.find((message) => message.type === 'snapshot');
  assert.exists(initialSnapshot);
  expect(initialSnapshot['timestamp']).toEqual(expect.any(Number));
  expect(initialSnapshot.data).toMatchObject({
    kind: 'keyframe',
    sequence: 1,
  });
  for (const eo of engine.getAllSatellites()) {
    engine.handleSatelliteDamage(eo.id, 'legacy', SATELLITE.HEALTH);
  }
  engine.removeAsteroid(rock.id);
  reconnected.socket.send(JSON.stringify({ type: 'snapshotResync' }));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  broadcaster.broadcastGameState();
  await expect
    .poll(() => reconnected.messages.filter((message) => message.type === 'snapshot').length)
    .toBeGreaterThan(1);
  const latestSnapshot = reconnected.messages
    .filter((message) => message.type === 'snapshot')
    .at(-1);
  assert.exists(latestSnapshot);
  assert.exists(latestSnapshot.data);
  if (!isRecord(latestSnapshot.data)) {
    throw new Error('Snapshot envelope is missing its frame object');
  }
  expect(latestSnapshot.data['kind']).toBe('keyframe');
  const recoveredAfterResync = reconnected.state();
  assert.exists(recoveredAfterResync);
  expect(recoveredAfterResync.satelliteProjectiles).toEqual([]);
  expect(recoveredAfterResync.collabTags).toEqual([]);
  expect(reconnected.errors).toEqual([]);
});
