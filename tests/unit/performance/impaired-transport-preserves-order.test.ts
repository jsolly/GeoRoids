import { createConnection, createServer } from 'node:net';
import { expect, test } from 'vitest';
import { startTcpProxy, TransmissionSchedule } from '../../../benchmarks/tcp-proxy';

test('a throttled recipient receives the entire byte stream in order and cleanup closes both sides', async () => {
  const server = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Echo server did not bind');
  }
  const proxy = await startTcpProxy({
    targetPort: address.port,
    latencyMs: 1,
    jitterMs: 1,
    downBytesPerSecond: 1_000_000,
    upBytesPerSecond: 1_000_000,
    seed: 42,
  });
  const socket = createConnection({ host: '127.0.0.1', port: proxy.port });
  const payload = Buffer.alloc(256 * 1024);
  for (let i = 0; i < payload.length; i++) {
    payload[i] = i % 251;
  }
  try {
    const received = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      socket.setTimeout(4000, () => reject(new Error('Proxy stalled')));
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size === payload.length) {
          resolve(Buffer.concat(chunks));
        }
      });
      socket.write(payload);
    });
    expect(received.equals(payload)).toBe(true);
    expect(proxy.read()).toMatchObject({
      bytesUp: payload.length,
      bytesDown: payload.length,
      failures: 0,
    });
    expect(proxy.read().peakWritableBytes).toBeLessThanOrEqual(128 * 1024);
  } finally {
    socket.destroy();
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  expect(proxy.read().activeSockets).toBe(0);
});

test('propagation overlaps across queued chunks while bandwidth and FIFO remain enforced', () => {
  const schedule = new TransmissionSchedule(1000, 90);
  expect(schedule.schedule(0, 10, 0).deliveryAt).toBe(100);
  expect(schedule.schedule(20, 10, 0).deliveryAt).toBe(120);
  expect(schedule.schedule(21, 10, -80).deliveryAt).toBe(120);
  expect(schedule.schedule(22, 100, 0).deliveryAt).toBe(230);
});

test('a normal-profile download sustains configured bandwidth without charging latency per chunk', async () => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  const server = createServer((socket) => socket.write(payload));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Source did not bind');
  }
  const rate = 625000;
  const proxy = await startTcpProxy({
    targetPort: address.port,
    latencyMs: 40,
    jitterMs: 20,
    downBytesPerSecond: rate,
    upBytesPerSecond: 125000,
    seed: 42,
  });
  const started = performance.now();
  const socket = createConnection({ host: '127.0.0.1', port: proxy.port });
  try {
    const result = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      socket.setTimeout(7000, () => reject(new Error('Sustained download stalled')));
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        bytes += chunk.length;
        if (bytes === payload.length) {
          resolve(Buffer.concat(chunks));
        }
      });
    });
    const elapsed = performance.now() - started;
    expect(result.equals(payload)).toBe(true);
    const serialized = (payload.length / rate) * 1000;
    expect(elapsed).toBeGreaterThanOrEqual(serialized * 0.95);
    expect(elapsed).toBeLessThan((serialized + 60) * 1.2);
    expect(proxy.read().peakPendingDeliveryBytes).toBeLessThanOrEqual(2 * 65536 + rate * 0.06);
  } finally {
    socket.destroy();
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  expect(proxy.read()).toMatchObject({ activeSockets: 0, pendingTimers: 0 });
}, 10000);

test('closing a throttled connection cancels and accounts for pending delivery timers', async () => {
  const server = createServer((socket) => socket.write('pending delivery'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Source did not bind');
  }
  const proxy = await startTcpProxy({
    targetPort: address.port,
    latencyMs: 5000,
    jitterMs: 0,
    downBytesPerSecond: 1000,
    upBytesPerSecond: 1000,
    seed: 42,
  });
  const socket = createConnection({ host: '127.0.0.1', port: proxy.port });
  try {
    await expect.poll(() => proxy.read().pendingTimers).toBeGreaterThan(0);
  } finally {
    socket.destroy();
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  expect(proxy.read()).toMatchObject({ activeSockets: 0, pendingTimers: 0 });
});
