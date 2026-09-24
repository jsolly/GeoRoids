import assert from 'node:assert/strict';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { Pilot } from '../../../benchmarks/pilot';
import { SnapshotEncoder } from '../../../shared/snapshotProtocol';
import { snapshotFixture } from '../network/snapshotFixture';

test.each([false, true])(
  'a pilot waits for its first world before driving when compression is %s',
  async (compression) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      perMessageDeflate: compression,
    });
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const connected = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
    const failures: unknown[] = [];
    const pilot = new Pilot(0, {
      url: new URL(`ws://127.0.0.1:${address.port}/ws`),
      measuring: () => false,
      fail: (error) => failures.push(error),
    });
    try {
      const peer = await connected;
      const requests: string[] = [];
      peer.on('message', (data) => requests.push(String(data)));
      await once(peer, 'message');
      expect(JSON.parse(requests[0] ?? '')).toMatchObject({ type: 'join', id: pilot.id });

      const acknowledged = once(pilot.socket, 'message');
      peer.send(
        JSON.stringify({
          type: 'joined',
          data: {
            id: pilot.id,
            snapshotVersion: 1,
            asteroidInteractions: 1,
            resumeToken: 'a'.repeat(64),
          },
        })
      );
      await acknowledged;
      expect(pilot.joined).toBe(true);
      expect(pilot.state).toBeUndefined();
      expect(pilot.report().webSocketExtensions).toBe(compression ? 'permessage-deflate' : '');
      pilot.drive(1);
      const settled = once(peer, 'pong');
      peer.ping();
      await settled;
      expect(requests).toHaveLength(1);

      const clock = vi.spyOn(performance, 'now').mockReturnValue(pilot.sessionStartedAt + 10_001);
      try {
        expect(() => pilot.drive(1)).toThrow('Game rejoin timed out');
      } finally {
        clock.mockRestore();
      }

      const world = snapshotFixture();
      const first = world.entities[0];
      assert(first);
      world.entities.push({
        ...first,
        id: pilot.id,
        playerMotion: { epoch: 1, ack: 0, mode: 'free' },
      });
      const received = once(pilot.socket, 'message');
      peer.send(JSON.stringify({ type: 'snapshot', data: new SnapshotEncoder(world).encode(1) }));
      await received;
      expect(pilot.state).toEqual(world);

      const moved = once(peer, 'message');
      pilot.drive(1);
      const [movement] = await moved;
      expect(JSON.parse(String(movement))).toMatchObject({
        type: 'update',
        id: pilot.id,
        data: { motionEpoch: 1, motionSequence: 1, thrusting: true },
      });

      const generation = pilot.gameJoins;
      const deadWorld = structuredClone(world);
      const deadPilot = deadWorld.entities.find((entity) => entity.id === pilot.id);
      assert(deadPilot);
      deadPilot.health = 0;
      deadPilot.exploding = true;
      const deathReceived = once(pilot.socket, 'message');
      peer.send(
        JSON.stringify({ type: 'snapshot', data: new SnapshotEncoder(deadWorld).encode(2) })
      );
      await deathReceived;
      pilot.drive(2);
      expect(pilot.gameJoins).toBe(generation);
      expect(pilot.state).toBeDefined();
      const respawned = once(pilot.socket, 'message');
      peer.send(JSON.stringify({ type: 'snapshot', data: new SnapshotEncoder(world).encode(3) }));
      await respawned;
      expect(pilot.state?.entities.find((entity) => entity.id === pilot.id)?.health).toBe(100);
      expect(failures).toEqual([]);
    } finally {
      try {
        await pilot.close();
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  }
);
