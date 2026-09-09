import assert from 'node:assert/strict';
import { createConnection, createServer, type Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';

/** A bounded FIFO TCP impairment. Transport order is preserved; no application frames are dropped. */
export async function startTcpProxy(options: {
  targetPort: number;
  latencyMs: number;
  jitterMs: number;
  downBytesPerSecond: number;
  upBytesPerSecond: number;
  seed: number;
}) {
  const sockets = new Set<Socket>();
  let bytesUp = 0;
  let bytesDown = 0;
  let peakWritableBytes = 0;
  let failures = 0;
  let seed = options.seed >>> 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closing = false;
  class ImpairedDirection extends Transform {
    constructor(
      private readonly rate: number,
      private readonly down: boolean
    ) {
      super({ highWaterMark: 64 * 1024 });
    }
    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const jitter = (seed / 2 ** 32 - 0.5) * 2 * options.jitterMs;
      // Each chunk waits in a FIFO. Report measured RTT; configured latency alone is not effective RTT.
      const wait = Math.max(0, options.latencyMs + jitter) + (chunk.length / this.rate) * 1000;
      peakWritableBytes = Math.max(peakWritableBytes, this.writableLength);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (this.down) {
          bytesDown += chunk.length;
        } else {
          bytesUp += chunk.length;
        }
        callback(null, chunk);
      }, wait);
      timers.add(timer);
    }
  }
  for (const value of [options.latencyMs, options.jitterMs]) {
    assert(Number.isFinite(value) && value >= 0, 'Invalid proxy delay');
  }
  for (const value of [options.downBytesPerSecond, options.upBytesPerSecond]) {
    assert(Number.isFinite(value) && value > 0, 'Invalid proxy rate');
  }
  const server = createServer((client) => {
    const upstream = createConnection({ host: '127.0.0.1', port: options.targetPort });
    const up = new ImpairedDirection(options.upBytesPerSecond, false);
    const down = new ImpairedDirection(options.downBytesPerSecond, true);
    sockets.add(client);
    sockets.add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      up.destroy();
      down.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    for (const socket of [client, upstream]) {
      socket.on('error', () => {
        if (!closing) {
          failures++;
        }
        close();
      });
      socket.on('close', close);
    }
    up.on('error', close);
    down.on('error', close);
    client.pipe(up).pipe(upstream);
    upstream.pipe(down).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    port: address.port,
    read: () => ({ bytesUp, bytesDown, peakWritableBytes, failures, activeSockets: sockets.size }),
    close: async () => {
      closing = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      for (const timer of timers) {
        clearTimeout(timer);
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          ),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('TCP proxy cleanup timed out')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        for (const socket of sockets) {
          socket.destroy();
          socket.unref();
        }
        server.unref();
      }
    },
  };
}
