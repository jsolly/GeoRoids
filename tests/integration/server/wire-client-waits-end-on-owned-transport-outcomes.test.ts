/* @vitest-environment node */
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { closePlayerMotionScenario } from '../../support/playerMotionCleanup';
import { WireClient } from '../../support/wireClient';

let server: WebSocketServer | undefined;
let client: WireClient | undefined;
let expectedFailure: Error | undefined;

async function connect(): Promise<{ wire: WireClient; peer: WebSocket }> {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening', { signal: AbortSignal.timeout(2000) });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing owned loopback address');
  }
  const connected = once(server, 'connection', { signal: AbortSignal.timeout(2000) });
  const wire = new WireClient(new WebSocket(`ws://127.0.0.1:${address.port}`));
  client = wire;
  await wire.open();
  const [peer] = await connected;
  if (!(peer instanceof WebSocket)) {
    throw new Error('Missing owned peer');
  }
  return { wire, peer };
}

afterEach(async () => {
  const ownedClient = client;
  const ownedServer = server;
  try {
    await closePlayerMotionScenario({
      clients: ownedClient
        ? [
            {
              async close() {
                await ownedClient.close();
                expect(ownedClient.failures).toEqual(expectedFailure ? [expectedFailure] : []);
              },
            },
          ]
        : [],
      server: ownedServer
        ? {
            close: () =>
              new Promise<void>((resolve, reject) => {
                ownedServer.close((error) => (error ? reject(error) : resolve()));
              }),
          }
        : undefined,
    });
  } finally {
    server = undefined;
    client = undefined;
    expectedFailure = undefined;
  }
});

test('a later snapshot decoder rejects an otherwise satisfied message predicate', async () => {
  const { wire, peer } = await connect();
  const decoder = new SnapshotDecoder('live');
  wire.ws.on('message', (raw) => {
    const result = decoder.readMessage(String(raw), { acceptSnapshots: true });
    if (result.kind === 'snapshot-rejected') {
      expectedFailure = result.error;
      wire.failures.push(result.error);
    }
  });
  const decoded = wire.waitFor(
    () => wire.messages.find((message) => message.type === 'snapshot'),
    'decoded snapshot'
  );
  peer.send(JSON.stringify({ type: 'snapshot', data: { version: 999 } }));
  const observed = await decoded.then(
    () => null,
    (error: unknown) => error
  );
  expect(observed).toBe(expectedFailure);
  expect(expectedFailure).toBeInstanceOf(Error);
  await expect(wire.waitFor(() => true, 'already satisfied')).rejects.toBe(expectedFailure);
});

test('deadline cleanup permits a later message and closed transports settle current and new waits', async () => {
  const { wire, peer } = await connect();
  await expect(wire.waitFor(() => undefined, 'missing message', 20)).rejects.toThrow(
    'Timed out: missing message'
  );
  const observed = wire.waitFor(
    () => wire.messages.find((message) => message.type === 'ready'),
    'later message'
  );
  peer.send(JSON.stringify({ type: 'ready' }));
  await expect(observed).resolves.toEqual({ type: 'ready' });
  const pending = wire.waitFor(() => undefined, 'before close');
  peer.close();
  await expect(pending).rejects.toThrow('Socket closed before before close');
  await expect(wire.waitFor(() => undefined, 'after close')).rejects.toThrow(
    'Socket closed before after close'
  );
  await expect(wire.open()).rejects.toThrow('Socket closed before socket open');
});
