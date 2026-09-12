import assert from 'node:assert/strict';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { observesPreparedFixture } from '../../../benchmarks/fixture-readiness';
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

      const preparedGeneration = pilot.gameJoins;
      const oldSession = structuredClone(world);
      const oldPilot = oldSession.entities.find((entity) => entity.id === pilot.id);
      assert(oldPilot, 'old-session pilot');
      oldPilot.playerMotion = { epoch: 9, ack: 0, mode: 'free' };
      oldPilot.lives = 0;
      const oldReceived = once(pilot.socket, 'message');
      peer.send(
        JSON.stringify({ type: 'snapshot', data: new SnapshotEncoder(oldSession).encode(2) })
      );
      await oldReceived;
      pilot.drive(2);
      expect(pilot.gameJoins).toBe(preparedGeneration + 1);
      expect(pilot.state).toBeUndefined();
      expect(pilot.lastKeyframeSequence).toBe(0);

      const staleSession = structuredClone(oldSession);
      const stalePilot = staleSession.entities.find((entity) => entity.id === pilot.id);
      assert(stalePilot?.playerMotion, 'stale-session pilot motion');
      stalePilot.lives = 3;
      expect(
        observesPreparedFixture(
          { sequence: 2, gameTime: staleSession.gameTime, motionEpoch: 2 },
          {
            lastKeyframeSequence: 3,
            lastSnapshotGameTime: staleSession.gameTime,
            motionEpoch: stalePilot.playerMotion.epoch,
          }
        )
      ).toBe(true);
      const staleReceived = once(pilot.socket, 'message');
      peer.send(
        JSON.stringify({ type: 'snapshot', data: new SnapshotEncoder(staleSession).encode(3) })
      );
      await staleReceived;
      expect(pilot.gameJoins).not.toBe(preparedGeneration);
      expect(pilot.state).toBeUndefined();

      const rejoined = once(pilot.socket, 'message');
      peer.send(
        JSON.stringify({
          type: 'joined',
          data: {
            id: pilot.id,
            snapshotVersion: 1,
            asteroidInteractions: 1,
            resumeToken: 'b'.repeat(64),
          },
        })
      );
      await rejoined;
      const freshSession = structuredClone(staleSession);
      const freshPilot = freshSession.entities.find((entity) => entity.id === pilot.id);
      assert(freshPilot, 'fresh-session pilot');
      freshPilot.playerMotion = { epoch: 2, ack: 0, mode: 'free' };
      const freshReceived = once(pilot.socket, 'message');
      peer.send(
        JSON.stringify({ type: 'snapshot', data: new SnapshotEncoder(freshSession).encode(1) })
      );
      await freshReceived;
      expect(
        pilot.state?.entities.find((entity) => entity.id === pilot.id)?.playerMotion?.epoch
      ).toBe(2);
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
