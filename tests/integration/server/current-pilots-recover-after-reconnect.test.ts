import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import { nearbyWorldRows } from '../../../shared/world';
import type { ServerGameSnapshot } from '../../../shared-types';
import { ROID } from '../../../src/constants';
import { snapshotFixture } from '../../unit/network/snapshotFixture';

const RESUME_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    cleanup = undefined;
    vi.restoreAllMocks();
  }
});

test('current sockets render matching worlds across late join and reconnect', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const failures: unknown[] = [];
  const engine = new GameEngine(731);
  vi.spyOn(engine, 'getServerTime').mockReturnValue(10_000);
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
    expect(failures).toEqual([]);
  };
  wss.on('connection', (socket) => {
    socket.on('error', (error) => failures.push(error));
    socket.on('message', (text) => {
      try {
        const message: unknown = JSON.parse(text.toString());
        handler.handleMessage(message, socket);
      } catch (error) {
        failures.push(error);
      }
    });
    socket.on('close', () => {
      engine.transportClosed(socket);
    });
  });
  await once(wss, 'listening', { signal: AbortSignal.timeout(2_000) });
  const address = wss.address();
  if (!address || typeof address === 'string') {
    throw new Error('No test port');
  }
  const port = address.port;
  async function pilot(id: string, resumeToken?: string) {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?snapshotVersion=1&asteroidInteractions=1`
    );
    clients.push(socket);
    const decoder = new SnapshotDecoder();
    const messages: Array<{ type: string; data: unknown }> = [];
    let state: unknown;
    let snapshot: ServerGameSnapshot | undefined;
    socket.on('error', (error) => failures.push(error));
    socket.on('message', (text) => {
      try {
        const wireText = text.toString();
        const result = decoder.readMessage(wireText, { acceptSnapshots: true });
        if (result.kind === 'snapshot-rejected') {
          throw result.error;
        }
        if (result.kind === 'snapshot') {
          snapshot = result.state;
          state = result.state;
          messages.push({ type: 'snapshot', data: result.metadata });
          return;
        }
        const raw = result.message;
        assert.ok(raw && typeof raw === 'object' && 'type' in raw && typeof raw.type === 'string');
        assert.ok('data' in raw, 'Expected server message data');
        messages.push({ type: raw.type, data: raw.data });
        if (raw.type === 'joined') {
          decoder.reset();
        }
      } catch (error) {
        failures.push(error);
      }
    });
    await once(socket, 'open', { signal: AbortSignal.timeout(2_000) });
    socket.send(
      JSON.stringify({
        type: 'join',
        data: {
          id,
          name: id,
          position: { x: 100, y: 100 },
          snapshotVersion: 1,
          asteroidInteractions: 1,
          ...(resumeToken ? { resumeToken } : {}),
        },
      })
    );
    await expect.poll(() => state).toBeDefined();
    return { socket, messages, state: () => state, snapshot: () => snapshot };
  }
  const first = await pilot('first');
  const second = await pilot('second');
  const expectedWorld = (position: { x: number; y: number }) => {
    const gameState = engine.getGameState();
    const asteroids = nearbyWorldRows(gameState.asteroids, position);
    const asteroidIds = new Set(asteroids.map((asteroid) => asteroid.id));
    return new SnapshotEncoder({
      ...gameState,
      asteroids,
      loot: nearbyWorldRows(gameState.loot, position),
      satellitePickups: nearbyWorldRows(gameState.satellitePickups, position),
      playerProjectiles: nearbyWorldRows(engine.getPlayerProjectiles(), position),
      collabTags: engine
        .getActiveCollabTags()
        .filter((tag) => asteroidIds.has(tag.asteroidId))
        .map((tag) => ({ id: tag.asteroidId, ...tag })),
    }).state;
  };
  // Seed a real active shot and a normal large ice rock's cooperative window.
  // These must survive reconnect even when the one-shot event was missed.
  const firstPlayer = engine.getPlayer('first');
  const secondPlayer = engine.getPlayer('second');
  assert.ok(firstPlayer && secondPlayer);
  const shot = engine.spawnLaser(
    'first',
    { x: firstPlayer.position.x + 20, y: firstPlayer.position.y },
    { x: 8, y: 0 }
  );
  assert.ok(shot);
  expect(engine.getPlayerProjectiles().length).toBeGreaterThan(0);
  expect(engine.getAllSatellitePickups()).toHaveLength(6);
  const rockFixture = snapshotFixture().asteroids[0];
  assert.ok(rockFixture);
  const rock = {
    ...rockFixture,
    id: 'recoverable-ice',
    material: 'ice' as const,
    size: ROID.COLLAB_SPLIT_MIN_SIZE,
    isCollabTarget: false,
  };
  engine.addAsteroid(rock);
  expect(engine.handleAsteroidHit(rock.id, 'first').outcome).toBe('tagged');
  expect(engine.getActiveCollabTags().map((tag) => tag.asteroidId)).toContain(rock.id);
  for (let tick = 0; tick < 8; tick++) {
    secondPlayer.position.x += 4;
    broadcaster.broadcastGameState();
    await expect.poll(() => first.state()).toEqual(expectedWorld(firstPlayer.position));
    await expect.poll(() => second.state()).toEqual(expectedWorld(secondPlayer.position));
  }
  expect(first.messages.some((message) => message.type === 'snapshot')).toBe(true);
  expect(first.state()).toHaveProperty('playerProjectiles');
  expect(first.state()).toHaveProperty('collabTags');
  expect(first.state()).toHaveProperty('satellitePickups');
  expect(failures).toEqual([]);
  const joined = second.messages.find((message) => message.type === 'joined')?.data;
  assert.ok(joined && typeof joined === 'object' && 'resumeToken' in joined);
  assert.equal(typeof joined.resumeToken, 'string');
  const token = joined.resumeToken as string;
  expect(token).toMatch(RESUME_TOKEN_PATTERN);
  const preservedPosition = { ...secondPlayer.position };
  const closed = once(second.socket, 'close', { signal: AbortSignal.timeout(2_000) });
  second.socket.close();
  await closed;
  expect(engine.getPlayer('second')).toBe(secondPlayer);
  const reconnected = await pilot('untrusted-replacement-id', token);
  expect(reconnected.messages.find((message) => message.type === 'joined')?.data).toMatchObject({
    id: 'second',
    resumeToken: token,
  });
  expect(engine.getPlayer('second')).toBe(secondPlayer);
  expect(secondPlayer.position).toEqual(preservedPosition);
  expect(engine.getPlayer('untrusted-replacement-id')).toBeUndefined();
  const recovered = reconnected.snapshot();
  assert.ok(recovered, 'Expected a decoded reconnect snapshot');
  expect(recovered.playerProjectiles.length).toBeGreaterThan(0);
  expect(recovered.collabTags.map((tag) => tag.asteroidId)).toContain(rock.id);
  expect(recovered.satellitePickups).toHaveLength(6);
  const firstFrame = reconnected.messages.find((message) => message.type === 'snapshot');
  assert.ok(firstFrame);
  expect(firstFrame.data).toMatchObject({
    kind: 'keyframe',
    sequence: 1,
  });
  engine.removeAsteroid(rock.id);
  reconnected.socket.send(JSON.stringify({ type: 'snapshotResync' }));
  const pong = once(reconnected.socket, 'pong', { signal: AbortSignal.timeout(2_000) });
  reconnected.socket.ping();
  await pong;
  broadcaster.broadcastGameState();
  await expect
    .poll(() => reconnected.messages.filter((message) => message.type === 'snapshot').length)
    .toBeGreaterThan(1);
  expect(
    reconnected.messages.filter((message) => message.type === 'snapshot').at(-1)?.data
  ).toMatchObject({ kind: 'keyframe' });
  const resynced = reconnected.snapshot();
  assert.ok(resynced);
  expect(resynced.collabTags).toEqual([]);
  expect(resynced.satellitePickups).toHaveLength(6);
  expect(failures).toEqual([]);
});
