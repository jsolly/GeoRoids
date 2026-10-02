import assert from 'node:assert/strict';
import { createConnection, createServer, type Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';

/** Serialization and propagation overlap for consecutive chunks; delivery stays FIFO. */
export class TransmissionSchedule {
  private transmissionFinishedAt = 0;
  private deliveryAt = 0;
  constructor(
    private readonly bytesPerSecond: number,
    private readonly latencyMs: number
  ) {}
  schedule(arrivedAt: number, bytes: number, jitterMs: number) {
    this.transmissionFinishedAt =
      Math.max(arrivedAt, this.transmissionFinishedAt) + (bytes / this.bytesPerSecond) * 1000;
    this.deliveryAt = Math.max(
      this.deliveryAt,
      this.transmissionFinishedAt + Math.max(0, this.latencyMs + jitterMs)
    );
    return { transmissionFinishedAt: this.transmissionFinishedAt, deliveryAt: this.deliveryAt };
  }
}

type Impairment = {
  latencyMs: number;
  jitterMs: number;
  downBytesPerSecond: number;
  upBytesPerSecond: number;
};

/** Bounded raw-byte forwarding: clean is transparent; impaired delivery preserves FIFO. */
export async function startTcpProxy(
  options: {
    targetPort: number;
    /** Stable owned benchmark endpoint; omitted binds an ephemeral test port. */
    port?: number;
    seed: number;
  } & ({ transparent: true } | (Impairment & { transparent?: false }))
) {
  const sockets = new Set<Socket>();
  let bytesUp = 0;
  let bytesDown = 0;
  let peakWritableBytes = 0;
  let peakPendingDeliveryBytes = 0;
  let failures = 0;
  let seed = options.seed >>> 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closing = false;
  const port = options.port ?? 0;
  assert(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'Invalid proxy listen port');
  class ImpairedDirection extends Transform {
    private readonly arrivals = new WeakMap<Buffer, number>();
    private readonly schedule: TransmissionSchedule;
    private readonly pendingLimit: number;
    private readonly queue: Array<{ chunk: Buffer; deliveryAt: number }> = [];
    private pendingBytes = 0;
    private outputBlocked = false;
    private input: { callback: TransformCallback; transmissionFinishedAt: number } | undefined;
    private inputTimer: ReturnType<typeof setTimeout> | undefined;
    private outputTimer: ReturnType<typeof setTimeout> | undefined;
    private flushCallback: TransformCallback | undefined;
    constructor(
      rate: number,
      private readonly down: boolean,
      private readonly impairment: Impairment
    ) {
      super({ highWaterMark: 64 * 1024 });
      this.schedule = new TransmissionSchedule(rate, impairment.latencyMs);
      // Room for propagation in flight plus one normal stream chunk. An ingress
      // chunk may exceed this threshold once; further input then backpressures.
      this.pendingLimit =
        65536 + Math.ceil((rate * (impairment.latencyMs + impairment.jitterMs)) / 1000);
    }
    arrived(chunk: Buffer) {
      this.arrivals.set(chunk, performance.now());
    }
    private cancel(timer: ReturnType<typeof setTimeout> | undefined) {
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    }
    private releaseInput() {
      const input = this.input;
      if (!input || this.destroyed) {
        return;
      }
      if (performance.now() < input.transmissionFinishedAt) {
        if (this.inputTimer) {
          return;
        }
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            if (this.inputTimer === timer) {
              this.inputTimer = undefined;
            }
            if (this.input === input) {
              this.releaseInput();
            }
          },
          Math.ceil(input.transmissionFinishedAt - performance.now())
        );
        this.inputTimer = timer;
        timers.add(timer);
        return;
      }
      this.cancel(this.inputTimer);
      this.inputTimer = undefined;
      if (this.pendingBytes > this.pendingLimit) {
        return;
      }
      this.input = undefined;
      input.callback();
    }
    private deliver() {
      if (this.destroyed) {
        return;
      }
      this.cancel(this.outputTimer);
      this.outputTimer = undefined;
      while (!this.outputBlocked) {
        const next = this.queue[0];
        if (!next) {
          break;
        }
        if (next.deliveryAt > performance.now()) {
          this.outputTimer = setTimeout(
            () => {
              if (this.outputTimer) {
                timers.delete(this.outputTimer);
              }
              this.outputTimer = undefined;
              this.deliver();
            },
            Math.ceil(next.deliveryAt - performance.now())
          );
          timers.add(this.outputTimer);
          break;
        }
        this.queue.shift();
        this.pendingBytes -= next.chunk.length;
        if (this.down) {
          bytesDown += next.chunk.length;
        } else {
          bytesUp += next.chunk.length;
        }
        this.outputBlocked = !this.push(next.chunk);
      }
      this.releaseInput();
      if (this.queue.length === 0 && this.flushCallback) {
        const done = this.flushCallback;
        this.flushCallback = undefined;
        done();
      }
    }
    override _read(size: number) {
      this.outputBlocked = false;
      super._read(size);
      this.deliver();
    }
    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const jitter = (seed / 2 ** 32 - 0.5) * 2 * this.impairment.jitterMs;
      const arrivedAt = this.arrivals.get(chunk);
      assert(arrivedAt !== undefined, 'Proxy chunk lacks an ingress timestamp');
      const schedule = this.schedule.schedule(arrivedAt, chunk.length, jitter);
      this.queue.push({ chunk, deliveryAt: schedule.deliveryAt });
      this.pendingBytes += chunk.length;
      peakWritableBytes = Math.max(peakWritableBytes, this.writableLength);
      peakPendingDeliveryBytes = Math.max(peakPendingDeliveryBytes, this.pendingBytes);
      this.input = { callback, transmissionFinishedAt: schedule.transmissionFinishedAt };
      this.releaseInput();
      this.deliver();
    }
    override _flush(callback: TransformCallback) {
      this.flushCallback = callback;
      this.deliver();
    }
    override _destroy(error: Error | null, callback: (error: Error | null) => void) {
      this.cancel(this.inputTimer);
      this.cancel(this.outputTimer);
      this.queue.length = 0;
      this.pendingBytes = 0;
      callback(error);
    }
  }
  class TransparentDirection extends Transform {
    constructor(private readonly down: boolean) {
      super({ highWaterMark: 64 * 1024 });
    }
    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      // The same outbound-stream admission boundary as impaired delivery,
      // without a transmission schedule, random jitter, timers, or rate cap.
      if (this.down) {
        bytesDown += chunk.length;
      } else {
        bytesUp += chunk.length;
      }
      peakWritableBytes = Math.max(peakWritableBytes, this.writableLength);
      callback(null, chunk);
    }
  }
  if (options.transparent !== true) {
    for (const value of [options.latencyMs, options.jitterMs]) {
      assert(Number.isFinite(value) && value >= 0, 'Invalid proxy delay');
    }
    for (const value of [options.downBytesPerSecond, options.upBytesPerSecond]) {
      assert(Number.isFinite(value) && value > 0, 'Invalid proxy rate');
    }
  }
  const server = createServer((client) => {
    const upstream = createConnection({ host: '127.0.0.1', port: options.targetPort });
    // Match WebSocket endpoints; only the declared schedule adds sender delay.
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const up =
      options.transparent === true
        ? new TransparentDirection(false)
        : new ImpairedDirection(options.upBytesPerSecond, false, options);
    const down =
      options.transparent === true
        ? new TransparentDirection(true)
        : new ImpairedDirection(options.downBytesPerSecond, true, options);
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
    const onSocketError = () => {
      if (!closing) {
        failures++;
      }
      close();
    };
    for (const socket of [client, upstream]) {
      socket.on('error', onSocketError);
      socket.on('close', close);
    }
    up.on('error', close);
    down.on('error', close);
    if (up instanceof ImpairedDirection && down instanceof ImpairedDirection) {
      client.on('data', (chunk: Buffer) => up.arrived(chunk));
      upstream.on('data', (chunk: Buffer) => down.arrived(chunk));
    }
    client.pipe(up).pipe(upstream);
    upstream.pipe(down).pipe(client);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    server.unref();
    throw error;
  }
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    port: address.port,
    read: () => ({
      bytesUp,
      bytesDown,
      peakWritableBytes,
      peakPendingDeliveryBytes,
      failures,
      activeSockets: sockets.size,
      pendingTimers: timers.size,
    }),
    close: async () => {
      closing = true;
      const socketClosures = [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
            socket.destroy();
          })
      );
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            ...socketClosures,
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            ),
          ]),
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
