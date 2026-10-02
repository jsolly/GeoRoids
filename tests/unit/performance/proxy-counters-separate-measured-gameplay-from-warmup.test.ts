// @vitest-environment node
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  parseProxyCounters,
  readProxyCounters,
  startProxyControl,
} from '../../../benchmarks/proxy-control';
import { startTcpProxy, TransmissionSchedule } from '../../../benchmarks/tcp-proxy';

async function exchange(port: number, payload: Buffer): Promise<Buffer> {
  const socket = createConnection({ host: '127.0.0.1', port });
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      socket.setTimeout(3000, () => reject(new Error('Echo stream stalled')));
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        bytes += chunk.length;
        if (bytes === payload.length) {
          resolve(Buffer.concat(chunks));
        }
      });
      socket.write(payload);
    });
  } finally {
    socket.destroy();
  }
}

test('a clean counting proxy preserves raw bytes without scheduling or capping and isolates the measured window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-proxy-counters-'));
  const path = join(directory, 'proxy.sock');
  const server = createServer((socket) => socket.pipe(socket));
  const schedule = vi.spyOn(TransmissionSchedule.prototype, 'schedule');
  let proxy: Awaited<ReturnType<typeof startTcpProxy>> | undefined;
  let closeControl: (() => Promise<void>) | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    proxy = await startTcpProxy({ targetPort: address.port, seed: 42, transparent: true });
    closeControl = await startProxyControl(path, 'clean', proxy.read);
    const warmup = Buffer.from('qualification HTTP and warmup are outside the measured boundary');
    expect(await exchange(proxy.port, warmup)).toEqual(warmup);
    const start = await readProxyCounters(path);
    const measured = Buffer.alloc(256 * 1024, 0xa5);
    expect(await exchange(proxy.port, measured)).toEqual(measured);
    const end = await readProxyCounters(path);
    expect(end.instanceId).toBe(start.instanceId);
    expect(end.profile).toBe('clean');
    expect(end.monotonicMs).toBeGreaterThan(start.monotonicMs);
    expect(end.bytesUp - start.bytesUp).toBe(measured.length);
    expect(end.bytesDown - start.bytesDown).toBe(measured.length);
    expect(end.bytesDown).toBe(warmup.length + measured.length);
    expect(end.pendingTimers).toBe(0);
    expect(end.peakPendingDeliveryBytes).toBe(0);
    expect(end.failures).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const partial = createConnection(path);
    partial.on('error', () => {});
    await once(partial, 'connect');
    partial.write('{');
    const closed = once(partial, 'close');
    await closeControl();
    closeControl = undefined;
    await closed;
    await expect(readProxyCounters(path)).rejects.toThrow();
    await proxy.close();
    expect(proxy.read()).toMatchObject({ activeSockets: 0, pendingTimers: 0 });
    proxy = undefined;
  } finally {
    schedule.mockRestore();
    try {
      await closeControl?.();
    } finally {
      try {
        await proxy?.close();
      } finally {
        try {
          if (server.listening) {
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            );
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
});

test('a stable proxy endpoint refuses another owner and can be rebound only after its owner closes', async () => {
  const first = await startTcpProxy({ targetPort: 1, seed: 42, transparent: true });
  const port = first.port;
  try {
    await expect(
      startTcpProxy({ targetPort: 1, port, seed: 42, transparent: true })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(first.read().activeSockets).toBe(0);
    expect(first.port).toBe(port);
  } finally {
    await first.close();
  }
  const next = await startTcpProxy({ targetPort: 1, port, seed: 42, transparent: true });
  try {
    expect(next.port).toBe(port);
  } finally {
    await next.close();
  }
  for (const invalid of [-1, 65536, 1.5, Number.NaN]) {
    await expect(
      startTcpProxy({ targetPort: 1, port: invalid, seed: 42, transparent: true })
    ).rejects.toThrow('Invalid proxy listen port');
  }
});

test('a private proxy reader rejects oversized and malformed replies instead of using stale file counters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-proxy-reply-'));
  const path = join(directory, 'proxy.sock');
  let oversized = true;
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () =>
      socket.end(oversized ? Buffer.alloc(1025, 0x20) : '{"bytesDown":123}\n')
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await expect(readProxyCounters(path)).rejects.toThrow('exceeds bound');
    oversized = false;
    await expect(readProxyCounters(path)).rejects.toThrow('Invalid proxy counter fields');
  } finally {
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('a proxy receipt rejects missing fields, extra data, unsafe counters and unknown profile identities', () => {
  const valid = {
    instanceId: 'owned-proxy',
    profile: 'clean',
    monotonicMs: 1.25,
    bytesUp: 1,
    bytesDown: 2,
    peakWritableBytes: 3,
    peakPendingDeliveryBytes: 4,
    failures: 0,
    activeSockets: 2,
    pendingTimers: 0,
  };
  expect(parseProxyCounters(valid)).toEqual(valid);
  for (const malformed of [
    null,
    [],
    { bytesUp: 1 },
    { ...valid, extra: 'unbounded data' },
    { ...valid, bytesDown: -1 },
    { ...valid, bytesUp: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, failures: 0.5 },
    { ...valid, monotonicMs: Number.NaN },
    { ...valid, monotonicMs: -1 },
    { ...valid, profile: 'unknown' },
    { ...valid, instanceId: '' },
    { ...valid, instanceId: 'x'.repeat(129) },
  ]) {
    expect(() => parseProxyCounters(malformed)).toThrow();
  }
});

test('a private counter socket refuses unknown operations, extra fields and oversized requests without touching counters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-proxy-requests-'));
  const path = join(directory, 'proxy.sock');
  const read = vi.fn(() => ({
    bytesUp: 1,
    bytesDown: 2,
    peakWritableBytes: 3,
    peakPendingDeliveryBytes: 0,
    failures: 0,
    activeSockets: 0,
    pendingTimers: 0,
  }));
  let closeControl: (() => Promise<void>) | undefined;
  try {
    closeControl = await startProxyControl(path, 'degraded', read);
    for (const request of [
      '{"operation":"resetCounters"}\n',
      '{"operation":"readCounters","extra":true}\n',
      'x'.repeat(513),
    ]) {
      const socket = createConnection(path);
      socket.on('error', () => {});
      let replyBytes = 0;
      socket.on('data', (chunk: Buffer) => {
        replyBytes += chunk.length;
      });
      try {
        const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        socket.write(request);
        await closed;
        expect(replyBytes).toBe(0);
      } finally {
        socket.destroy();
      }
    }
    expect(read).not.toHaveBeenCalled();
    const actual = await readProxyCounters(path);
    expect(actual.profile).toBe('degraded');
    expect(actual.bytesDown).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
    // Another owner cannot replace the existing private socket or its instance.
    await expect(startProxyControl(path, 'clean', read)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect((await readProxyCounters(path)).instanceId).toBe(actual.instanceId);
  } finally {
    try {
      await closeControl?.();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
