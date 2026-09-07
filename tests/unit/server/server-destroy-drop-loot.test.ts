/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import { createServerInstance } from '../../../server/createServer';
import { GROWTH } from '../../../shared/shipGrowth';
import { ROID } from '../../../src/constants';

type ServerMsg = {
  type?: string;
  data?: {
    asteroids?: Array<{ id: string }>;
    asteroid?: { id: string };
    loot?: Array<{ id: string; kind?: string; position?: { x: number; y: number } }>;
    lootId?: string;
    playerId?: string;
    position?: { x: number; y: number };
  };
};

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
}

function collectMessages(ws: WebSocket): ServerMsg[] {
  const messages: ServerMsg[] = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(String(raw)) as ServerMsg);
    } catch {
      // ignore
    }
  });
  return messages;
}

async function waitFor(
  messages: ServerMsg[],
  predicate: (msg: ServerMsg) => boolean,
  timeoutMs = 5000
): Promise<ServerMsg> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for message. Seen: ${messages.map((m) => m.type).join(',')}`);
}

describe('shared destroy-drop shards over WebSocket', () => {
  let server: ReturnType<typeof createServerInstance> | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    sockets.length = 0;
    if (server) {
      await server.close();
      server = null;
    }
  });

  test('two clients see the same shard and explode removes it for both', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;

    const a = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const b = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(a, b);
    await Promise.all([waitForOpen(a), waitForOpen(b)]);
    const fromA = collectMessages(a);
    const fromB = collectMessages(b);

    a.send(JSON.stringify({ type: 'join', id: 'pilot-a', name: 'A', position: { x: 350, y: -450 } }));
    b.send(JSON.stringify({ type: 'join', id: 'pilot-b', name: 'B', position: { x: 800, y: 800 } }));
    await waitFor(fromA, (msg) => msg.type === 'joined');
    await waitFor(fromB, (msg) => msg.type === 'joined');
    a.send(JSON.stringify({ type: 'update', id: 'pilot-a', position: { x: 350, y: -450 } }));
    b.send(JSON.stringify({ type: 'update', id: 'pilot-b', position: { x: 800, y: 800 } }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    server.gameEngine.addAsteroid({
      id: 'roid-shared',
      position: { x: 450, y: -450 },
      velocity: { x: 0, y: 0 },
      size: 12,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 10,
      maxHealth: 10,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });

    a.send(
      JSON.stringify({
        type: 'asteroidDestroyed',
        asteroidId: 'roid-shared',
        playerId: 'pilot-a',
        points: ROID.POINTS_SMALL,
        cause: 'laser',
        laserPosition: { x: 450, y: -450 },
      })
    );

    const stateA = await waitFor(
      fromA,
      (msg) =>
        msg.type === 'gameState' &&
        (msg.data?.loot ?? []).some((drop) => drop.kind === 'shard')
    );
    const stateB = await waitFor(
      fromB,
      (msg) =>
        msg.type === 'gameState' &&
        (msg.data?.loot ?? []).some((drop) => drop.kind === 'shard')
    );
    const shardA = stateA.data?.loot?.find((drop) => drop.kind === 'shard');
    const shardB = stateB.data?.loot?.find((drop) => drop.kind === 'shard');
    expect(shardA?.id).toBe(shardB?.id);
    expect(shardA?.id).toBeDefined();

    a.send(
      JSON.stringify({
        type: 'lootExplode',
        id: 'pilot-a',
        data: { lootId: shardA?.id, playerId: 'pilot-a' },
      })
    );

    await waitFor(fromA, (msg) => msg.type === 'lootExploded' && msg.data?.lootId === shardA?.id);
    await waitFor(fromB, (msg) => msg.type === 'lootExploded' && msg.data?.lootId === shardA?.id);
    expect(server.gameEngine.getLoot()).toHaveLength(0);
    expect(server.gameEngine.getPlayer('pilot-a')?.score).toBe(ROID.POINTS_SMALL);
    expect(GROWTH.SHARD_MASS).toBeGreaterThan(0);
  });
});
