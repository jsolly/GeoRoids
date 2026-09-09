import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { captureSnapshot, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';
import { ROID, SATELLITE } from '../../../src/constants';
import { snapshotFixture } from '../../unit/network/snapshotFixture';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    cleanup = undefined;
    vi.restoreAllMocks();
  }
});

test('real legacy and negotiated sockets render matching worlds across late join and reconnect', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const failures: unknown[] = [];
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
      const player = engine.getPlayerBySocket(socket);
      if (player) {
        engine.removePlayer(player.id);
      }
    });
  });
  await once(wss, 'listening', { signal: AbortSignal.timeout(2_000) });
  const address = wss.address();
  if (!address || typeof address === 'string') {
    throw new Error('No test port');
  }
  const port = address.port;
  async function pilot(id: string, negotiate: boolean) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(socket);
    const decoder = new SnapshotDecoder();
    const messages: Array<{ type: string; data: unknown }> = [];
    let state: unknown;
    let snapshot: ServerGameSnapshot | undefined;
    socket.on('error', (error) => failures.push(error));
    socket.on('message', (text) => {
      try {
        const raw: unknown = JSON.parse(text.toString());
        assert.ok(raw && typeof raw === 'object' && 'type' in raw && typeof raw.type === 'string');
        assert.ok('data' in raw, 'Expected server message data');
        const message = { type: raw.type, data: raw.data };
        messages.push(message);
        if (message.type === 'snapshot') {
          snapshot = decoder.decode(message.data);
          state = snapshot;
        }
        if (message.type === 'gameState') {
          state = message.data;
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
          ...(negotiate ? { snapshotVersion: 1 } : {}),
        },
      })
    );
    await expect.poll(() => state).toBeDefined();
    return { socket, messages, state: () => state, snapshot: () => snapshot };
  }
  const old = await pilot('legacy', false);
  const modern = await pilot('new', true);
  // Seed a real active shot and a normal large ice rock's cooperative window.
  // These must survive reconnect even when the one-shot event was missed.
  const satellite = engine.getAllSatellites()[0];
  const legacyPlayer = engine.getPlayer('legacy');
  const modernPlayer = engine.getPlayer('new');
  assert.ok(satellite && legacyPlayer && modernPlayer);
  legacyPlayer.position = { x: satellite.position.x + 180, y: satellite.position.y };
  for (let frame = 0; frame < 240 && engine.getActiveSatelliteProjectiles().length === 0; frame++) {
    engine.tickSatellites();
  }
  expect(engine.getActiveSatelliteProjectiles().length).toBeGreaterThan(0);
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
  expect(engine.handleAsteroidHit(rock.id, 'legacy').outcome).toBe('tagged');
  expect(engine.getActiveCollabTags().map((tag) => tag.asteroidId)).toContain(rock.id);
  for (let tick = 0; tick < 8; tick++) {
    modernPlayer.position.x += 4;
    broadcaster.broadcastGameState();
    const expected: unknown = JSON.parse(JSON.stringify(engine.getGameState()));
    const complete = captureSnapshot({
      ...engine.getGameState(),
      playerProjectiles: engine.getPlayerProjectiles(),
      satelliteProjectiles: engine
        .getActiveSatelliteProjectiles()
        .map((shot) => ({ id: shot.shotId, ...shot })),
      collabTags: engine.getActiveCollabTags().map((tag) => ({ id: tag.asteroidId, ...tag })),
    });
    await expect.poll(() => modern.state()).toEqual(complete);
    await expect.poll(() => old.state()).toEqual(expected);
  }
  expect(old.messages.some((message) => message.type === 'snapshot')).toBe(false);
  expect(old.state()).not.toHaveProperty('satelliteProjectiles');
  expect(old.state()).not.toHaveProperty('collabTags');
  expect(failures).toEqual([]);
  modern.socket.close();
  await expect.poll(() => engine.getPlayer('new')).toBeUndefined();
  const reconnected = await pilot('new', true);
  const recovered = reconnected.snapshot();
  assert.ok(recovered, 'Expected a decoded reconnect snapshot');
  expect(recovered.satelliteProjectiles.length).toBeGreaterThan(0);
  expect(recovered.collabTags.map((tag) => tag.asteroidId)).toContain(rock.id);
  const firstFrame = reconnected.messages.find((message) => message.type === 'snapshot');
  assert.ok(firstFrame);
  expect(firstFrame.data).toMatchObject({
    kind: 'keyframe',
    sequence: 1,
  });
  for (const eo of engine.getAllSatellites()) {
    engine.handleSatelliteDamage(eo.id, 'legacy', SATELLITE.HEALTH);
  }
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
  expect(resynced.satelliteProjectiles).toEqual([]);
  expect(resynced.collabTags).toEqual([]);
  expect(failures).toEqual([]);
});
