// @vitest-environment node
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Socket } from 'node:net';
import { expect, test, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { networkProfiles } from '../../../benchmarks/network-profiles';
import { startTcpProxy } from '../../../benchmarks/tcp-proxy';
import { readBenchmarkCompression } from '../../../benchmarks/websocket-compression';
import {
  type SnapshotBaseline,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { WireClient } from '../../support/wireClient';
import { snapshotFixture } from '../network/snapshotFixture';

/** Observe complete WebSocket messages, independent of TCP chunk boundaries. */
async function deliver(sender: WebSocket, recipient: WebSocket, text: string): Promise<string> {
  const incoming = once(recipient, 'message', { signal: AbortSignal.timeout(5000) });
  const [, received] = await Promise.all([
    new Promise<void>((resolve, reject) =>
      sender.send(text, { compress: true }, (error) => (error ? reject(error) : resolve()))
    ),
    incoming,
  ]);
  const [raw, binary] = received;
  assert(Buffer.isBuffer(raw));
  expect(binary).toBe(false);
  expect(raw).toEqual(Buffer.from(text, 'utf8'));
  return raw.toString('utf8');
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const peer of server.clients) {
    peer.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Owned WebSocket cleanup stalled')), 5000);
    server.close((error) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

test.each(['clean', 'degraded'] as const)(
  'a pilot applies compressed worlds and advances ACKs while exchanging small commands through the owned %s proxy',
  async (profile) => {
    const tuning = readBenchmarkCompression('deflate-level1-no-context-8k');
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      perMessageDeflate: tuning.perMessageDeflate,
    });
    const settings: Array<{ socket: Socket; enabled: boolean; beforeForwarding: boolean }> = [];
    const originalSetNoDelay = Socket.prototype.setNoDelay;
    const noDelay = vi.spyOn(Socket.prototype, 'setNoDelay').mockImplementation(function (
      this: Socket,
      enabled
    ) {
      settings.push({
        socket: this,
        enabled: enabled !== false,
        beforeForwarding: this.listenerCount('data') === 0,
      });
      return originalSetNoDelay.call(this, enabled);
    });
    let proxy: Awaited<ReturnType<typeof startTcpProxy>> | undefined;
    let client: WireClient | undefined;
    const failures: Error[] = [];
    server.on('error', (error) => failures.push(error));
    try {
      await once(server, 'listening', { signal: AbortSignal.timeout(5000) });
      const address = server.address();
      assert(address && typeof address !== 'string');
      proxy = await startTcpProxy({
        targetPort: address.port,
        seed: 42,
        ...(profile === 'clean' ? { transparent: true as const } : networkProfiles.degraded),
      });
      const proxyPort = proxy.port;
      const connected = once(server, 'connection', { signal: AbortSignal.timeout(5000) });
      client = new WireClient(
        new WebSocket(`ws://127.0.0.1:${proxyPort}`, { perMessageDeflate: true })
      );
      const [, connection] = await Promise.all([client.open(), connected]);
      const peer: unknown = connection[0];
      assert(peer instanceof WebSocket);
      peer.on('error', (error) => failures.push(error));
      expect(peer.extensions).toBe('permessage-deflate');
      expect(client.ws.extensions).toBe('permessage-deflate');

      const decoder = new SnapshotDecoder();
      const applied: number[] = [];
      const acknowledged: number[] = [];
      let baseline: SnapshotBaseline | undefined;
      for (const sequence of [1, 2, 3]) {
        // Small commands and replies exercise both proxy sender legs between worlds.
        const command = { type: 'input', data: { seq: sequence, thrust: 1 } };
        expect(JSON.parse(await deliver(client.ws, peer, JSON.stringify(command)))).toEqual(
          command
        );
        const response = { type: 'inputAccepted', data: { seq: sequence } };
        expect(JSON.parse(await deliver(peer, client.ws, JSON.stringify(response)))).toEqual(
          response
        );

        const world = snapshotFixture(sequence - 1);
        world.serverTime = 1000 + sequence * 33;
        Object.assign(world, { futureProxyProof: '飛行士 🛰️ Δ'.repeat(512) });
        const encoder = new SnapshotEncoder(world);
        const message = encoder.encodeSerialized(sequence, baseline, world.serverTime);
        expect(message.frame.kind).toBe(sequence === 1 ? 'keyframe' : 'delta');
        if (message.frame.kind === 'delta') {
          expect(message.frame.baseline).toBe(acknowledged.at(-1));
        }
        const before = proxy.read();
        const text = await deliver(peer, client.ws, message.text);
        const after = proxy.read();
        if (sequence === 1) {
          // Actual proxy bytes prove compression, rather than negotiation alone.
          const rawBytes = Buffer.byteLength(message.text, 'utf8');
          expect(rawBytes).toBeGreaterThan(8192);
          expect(after.bytesDown - before.bytesDown).toBeGreaterThan(0);
          expect(after.bytesDown - before.bytesDown).toBeLessThan(rawBytes);
        }
        const result = decoder.readMessage(text, { acceptSnapshots: true });
        assert(result.kind === 'snapshot');
        expect(result.metadata.sequence).toBe(sequence);
        expect(result.state).toEqual(JSON.parse(JSON.stringify(encoder.state)));
        applied.push(result.metadata.sequence);

        // Receipt follows complete decode/application; only that frontier becomes a baseline.
        const ack = { type: 'snapshotAck', data: { sequence: applied.at(-1) } };
        const receivedAck: unknown = JSON.parse(
          await deliver(client.ws, peer, JSON.stringify(ack))
        );
        expect(receivedAck).toEqual({ type: 'snapshotAck', data: { sequence } });
        acknowledged.push(sequence);
        baseline = { sequence, state: encoder.state };
      }
      expect(applied).toEqual([1, 2, 3]);
      expect(acknowledged).toEqual(applied);
      client.assertHealthy();
      expect(failures).toEqual([]);
      expect(proxy.read()).toMatchObject({ failures: 0 });
      expect(proxy.read().bytesUp).toBeGreaterThan(0);
      const acceptedLeg = settings.find((setting) => setting.socket.localPort === proxyPort);
      const upstreamLeg = settings.find((setting) => setting.socket.remotePort === address.port);
      expect(acceptedLeg).toMatchObject({ enabled: true, beforeForwarding: true });
      expect(upstreamLeg).toMatchObject({ enabled: true, beforeForwarding: true });
    } finally {
      try {
        await client?.close();
      } finally {
        try {
          await proxy?.close();
          if (proxy) {
            expect(proxy.read()).toMatchObject({ activeSockets: 0, pendingTimers: 0 });
          }
        } finally {
          try {
            await closeServer(server);
          } finally {
            noDelay.mockRestore();
          }
        }
      }
    }
  },
  15_000
);
