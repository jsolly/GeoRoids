import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

const CONNECT_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 2_000;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isClosed(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.CLOSED;
}

async function closeSocket(socket: WebSocket, label: string): Promise<void> {
  if (isClosed(socket)) {
    return;
  }
  const closed = once(socket, 'close', { signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) });
  const results = await Promise.allSettled([
    closed,
    Promise.resolve().then(() => socket.close(1000, 'Benchmark cleanup')),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length && !isClosed(socket)) {
    const terminated = once(socket, 'close', { signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) });
    const forced = await Promise.allSettled([
      terminated,
      Promise.resolve().then(() => socket.terminate()),
    ]);
    failures.push(
      ...forced.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
  }
  if (failures.length) {
    throw new AggregateError(failures, `${label} did not close normally`);
  }
}

/** Owns only its ephemeral loopback listener and the connections it creates. */
export class OwnedLoopback {
  readonly clients: WebSocket[] = [];
  readonly peers: WebSocket[] = [];
  readonly transports: Socket[] = [];
  readonly failures: Error[] = [];
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly listener: WebSocketServer,
    private readonly onPeer?: (peer: WebSocket, request: IncomingMessage, index: number) => void
  ) {
    listener.on('error', (error) => this.failures.push(error));
    listener.on('connection', (peer, request) => {
      const index = this.peers.length;
      this.peers.push(peer);
      this.transports.push(request.socket);
      peer.on('error', (error) => this.failures.push(error));
      try {
        this.onPeer?.(peer, request, index);
      } catch (error) {
        this.failures.push(asError(error));
        peer.terminate();
      }
    });
  }

  assertHealthy(): void {
    if (this.failures.length) {
      throw new AggregateError(this.failures, 'Owned loopback failed');
    }
  }

  async connect(): Promise<{ client: WebSocket; peer: WebSocket; transport: Socket }> {
    if (this.closing) {
      throw new Error('Owned loopback is closing');
    }
    const address = this.listener.address();
    if (!address || typeof address === 'string') {
      throw new Error('Loopback has no listening address');
    }
    const connection = once(this.listener, 'connection', {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    this.clients.push(client);
    client.on('error', (error) => this.failures.push(error));
    const opened = once(client, 'open', { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    const results = await Promise.allSettled([connection, opened]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.failures.push(asError(result.reason));
      }
    }
    this.assertHealthy();
    const connected = results[0];
    if (connected?.status !== 'fulfilled' || !(connected.value[0] instanceof WebSocket)) {
      throw new Error('Loopback did not accept a WebSocket peer');
    }
    const peer = connected.value[0];
    const transport = this.transports[this.peers.indexOf(peer)];
    if (!transport) {
      throw new Error('Loopback peer has no owned TCP transport');
    }
    return { client, peer, transport };
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    const failures: unknown[] = [];
    const listenerClosed = once(this.listener, 'close', {
      signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
    }).catch((error: unknown) => failures.push(error));
    try {
      // Also close a listener whose asynchronous startup has not completed.
      // Stop accepting synchronously before closing any owned connection.
      this.listener.close();
    } catch (error) {
      failures.push(error);
    }
    const sockets = [...new Set([...this.clients, ...this.peers, ...this.listener.clients])];
    const closed = await Promise.allSettled(
      sockets.map((socket, index) => closeSocket(socket, `loopback socket ${index}`))
    );
    failures.push(
      ...closed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
    await listenerClosed;
    failures.push(...this.failures);
    if (failures.length) {
      throw new AggregateError(failures, 'Benchmark loopback cleanup failed');
    }
  }
}

export async function createOwnedLoopback(
  onPeer?: (peer: WebSocket, request: IncomingMessage, index: number) => void
): Promise<OwnedLoopback> {
  const owner = new OwnedLoopback(new WebSocketServer({ host: '127.0.0.1', port: 0 }), onPeer);
  const failures: unknown[] = [];
  try {
    await once(owner.listener, 'listening', { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    owner.assertHealthy();
    return owner;
  } catch (error) {
    failures.push(error);
    try {
      await owner.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
  }
  throw new AggregateError(failures, 'Owned loopback startup failed', { cause: failures[0] });
}
