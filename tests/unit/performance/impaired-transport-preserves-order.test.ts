import { createConnection, createServer } from 'node:net';
import { expect, test } from 'vitest';
import { startTcpProxy } from '../../../benchmarks/tcp-proxy';

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
