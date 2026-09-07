import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { GameEngine } from '../../../server/core/GameEngine';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { snapshotFixture } from '../../unit/network/snapshotFixture';
import { ROID, SATELLITE } from '../../../src/constants';
import type { ServerGameSnapshot, ServerGameState } from '../../../shared-types';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

test('real legacy and negotiated sockets render matching worlds across late join and reconnect', async () => {
  const engine = new GameEngine(731);
  const broadcaster = new GameStateBroadcaster(engine);
  const handler = new MessageHandler(engine, broadcaster);
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const clients: WebSocket[] = [];
  cleanup = async () => {
    for (const client of clients) { client.terminate(); }
    for (const client of wss.clients) { client.terminate(); }
    engine.stopGameLoop(); broadcaster.stopPeriodicBroadcast();
    await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
  };
  wss.on('connection', socket => {
    socket.on('message', text => handler.handleMessage(JSON.parse(text.toString()), socket));
    socket.on('close', () => {
      const player = engine.getPlayerBySocket(socket);
      if (player) { engine.removePlayer(player.id); }
    });
  });
  await new Promise<void>(resolve => wss.on('listening', resolve));
  const address = wss.address();
  if (!address || typeof address === 'string') { throw new Error('No test port'); }
  async function pilot(id: string, negotiate: boolean) {
    const socket = new WebSocket(`ws://127.0.0.1:${(address as { port: number }).port}`);
    clients.push(socket);
    const decoder = new SnapshotDecoder();
    const messages: any[] = [];
    let state: ServerGameState | undefined;
    const errors: unknown[] = [];
    socket.on('message', text => {
      try {
        const message = JSON.parse(text.toString()); messages.push(message);
        if (message.type === 'snapshot') { state = decoder.decode(message.data); }
        if (message.type === 'gameState') { state = message.data; }
      } catch (error) { errors.push(error); }
    });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'join', data: { id, name: id, position: { x: 100, y: 100 }, ...(negotiate ? { snapshotVersion: 1 } : {}) } }));
    await expect.poll(() => state).toBeDefined();
    return { socket, messages, errors, state: () => state };
  }
  const old = await pilot('legacy', false);
  const modern = await pilot('new', true);
  // Seed a real active shot and a normal large ice rock's cooperative window.
  // These must survive reconnect even when the one-shot event was missed.
  const satellite = engine.getAllSatellites()[0]!;
  engine.getPlayer('legacy')!.position = { x: satellite.position.x + 180, y: satellite.position.y };
  for (let frame = 0; frame < 240 && engine.getActiveSatelliteProjectiles().length === 0; frame++) {
    engine.tickSatellites();
  }
  expect(engine.getActiveSatelliteProjectiles().length).toBeGreaterThan(0);
  const rock = { ...snapshotFixture().asteroids[0]!, id: 'recoverable-ice',
    material: 'ice' as const, size: ROID.COLLAB_SPLIT_MIN_SIZE, isCollabTarget: false };
  engine.addAsteroid(rock);
  expect(engine.handleAsteroidHit(rock.id, 'legacy').outcome).toBe('tagged');
  expect(engine.getActiveCollabTags().map(tag => tag.asteroidId)).toContain(rock.id);
  for (let tick = 0; tick < 8; tick++) {
    engine.getPlayer('new')!.position.x += 4;
    broadcaster.broadcastGameState();
    const expected = JSON.parse(JSON.stringify(engine.getGameState()));
    const complete = { ...expected,
      satelliteProjectiles: engine.getActiveSatelliteProjectiles().map(shot => ({ id: shot.shotId, ...shot })),
      collabTags: engine.getActiveCollabTags().map(tag => ({ id: tag.asteroidId, ...tag })),
    };
    await expect.poll(() => modern.state()).toEqual(complete);
    await expect.poll(() => old.state()).toEqual(expected);
  }
  expect(old.messages.some(message => message.type === 'snapshot')).toBe(false);
  expect(old.state()).not.toHaveProperty('satelliteProjectiles');
  expect(old.state()).not.toHaveProperty('collabTags');
  expect(modern.errors).toEqual([]);
  modern.socket.close();
  await expect.poll(() => engine.getPlayer('new')).toBeUndefined();
  const reconnected = await pilot('new', true);
  const recovered = reconnected.state() as ServerGameSnapshot;
  expect(recovered.satelliteProjectiles.length).toBeGreaterThan(0);
  expect(recovered.collabTags.map(tag => tag.asteroidId)).toContain(rock.id);
  expect(reconnected.messages.find(message => message.type === 'snapshot').data).toMatchObject({ kind: 'keyframe', sequence: 1 });
  for (const eo of engine.getAllSatellites()) { engine.handleSatelliteDamage(eo.id, 'legacy', SATELLITE.HEALTH); }
  engine.removeAsteroid(rock.id);
  reconnected.socket.send(JSON.stringify({ type: 'snapshotResync' }));
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  broadcaster.broadcastGameState();
  await expect.poll(() => reconnected.messages.filter(message => message.type === 'snapshot').length).toBeGreaterThan(1);
  expect(reconnected.messages.filter(message => message.type === 'snapshot').at(-1).data.kind).toBe('keyframe');
  expect((reconnected.state() as ServerGameSnapshot).satelliteProjectiles).toEqual([]);
  expect((reconnected.state() as ServerGameSnapshot).collabTags).toEqual([]);
  expect(reconnected.errors).toEqual([]);
});
