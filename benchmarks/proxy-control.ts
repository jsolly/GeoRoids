import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import type { networkProfiles } from './network-profiles';

export interface ProxyCounters {
  instanceId: string;
  profile: keyof typeof networkProfiles;
  monotonicMs: number;
  /** Raw bytes admitted to outgoing streams, including framing and compressed payloads. */
  bytesUp: number;
  bytesDown: number;
  /** Peaks remain cumulative session diagnostics, not measured interval maxima. */
  peakWritableBytes: number;
  peakPendingDeliveryBytes: number;
  failures: number;
  activeSockets: number;
  pendingTimers: number;
}

const MAX_REQUEST_BYTES = 512;
const MAX_REPLY_BYTES = 1024;
const DEADLINE_MS = 10_000;
const MAX_CONTROL_SOCKETS = 32;

function counter(value: unknown): number {
  assert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'Invalid proxy counter'
  );
  return value;
}

export function parseProxyCounters(value: unknown): ProxyCounters {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid proxy counters');
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'activeSockets',
      'bytesDown',
      'bytesUp',
      'failures',
      'instanceId',
      'monotonicMs',
      'peakPendingDeliveryBytes',
      'peakWritableBytes',
      'pendingTimers',
      'profile',
    ],
    'Invalid proxy counter fields'
  );
  assert(
    'instanceId' in value &&
      typeof value.instanceId === 'string' &&
      value.instanceId.length > 0 &&
      value.instanceId.length <= 128 &&
      'profile' in value &&
      (value.profile === 'clean' || value.profile === 'normal' || value.profile === 'degraded') &&
      'monotonicMs' in value &&
      typeof value.monotonicMs === 'number' &&
      Number.isFinite(value.monotonicMs) &&
      value.monotonicMs >= 0 &&
      value.monotonicMs <= Number.MAX_SAFE_INTEGER &&
      'bytesUp' in value &&
      'bytesDown' in value &&
      'peakWritableBytes' in value &&
      'peakPendingDeliveryBytes' in value &&
      'failures' in value &&
      'activeSockets' in value &&
      'pendingTimers' in value,
    'Invalid proxy counter identity'
  );
  return {
    instanceId: value.instanceId,
    profile: value.profile,
    monotonicMs: value.monotonicMs,
    bytesUp: counter(value.bytesUp),
    bytesDown: counter(value.bytesDown),
    peakWritableBytes: counter(value.peakWritableBytes),
    peakPendingDeliveryBytes: counter(value.peakPendingDeliveryBytes),
    failures: counter(value.failures),
    activeSockets: counter(value.activeSockets),
    pendingTimers: counter(value.pendingTimers),
  };
}

/** A private live O(1) read: no file flush, counter reset, or transport schedule mutation. */
export async function startProxyControl(
  path: string,
  profile: ProxyCounters['profile'],
  read: () => Omit<ProxyCounters, 'instanceId' | 'profile' | 'monotonicMs'>
): Promise<() => Promise<void>> {
  const instanceId = randomUUID();
  const sockets = new Set<Socket>();
  const control = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    if (sockets.size >= MAX_CONTROL_SOCKETS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), DEADLINE_MS);
    socket.once('close', () => {
      clearTimeout(deadline);
      sockets.delete(socket);
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) {
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) {
        return;
      }
      handled = true;
      try {
        const command: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        assert(command && typeof command === 'object' && !Array.isArray(command));
        assert.deepEqual(Object.keys(command), ['operation']);
        assert('operation' in command && command.operation === 'readCounters');
        const reply = parseProxyCounters({
          ...read(),
          instanceId,
          profile,
          monotonicMs: performance.now(),
        });
        const text = `${JSON.stringify(reply)}\n`;
        assert(Buffer.byteLength(text, 'utf8') <= MAX_REPLY_BYTES, 'Proxy reply exceeds bound');
        socket.end(text);
      } catch {
        socket.destroy();
      }
    });
  });
  const close = async () => {
    const closedSockets = [...sockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once('close', resolve);
          socket.destroy();
        })
    );
    const listenerClosed = control.listening
      ? new Promise<void>((resolve, reject) => {
          control.close((error) => (error ? reject(error) : resolve()));
        })
      : Promise.resolve();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...closedSockets, listenerClosed]),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Proxy control cleanup timed out')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      for (const socket of sockets) {
        socket.destroy();
        socket.unref();
      }
      control.unref();
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(path, resolve);
    });
    await chmod(path, 0o600);
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}

/** Each boundary obtains fresh counters; absolute deadlines also reject slow trickled replies. */
export async function readProxyCounters(path: string): Promise<ProxyCounters> {
  const socket = createConnection(path);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ProxyCounters>((resolve, reject) => {
      let ended = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      deadline = setTimeout(() => reject(new Error('Proxy counters timed out')), DEADLINE_MS);
      socket.once('error', reject);
      socket.once('connect', () => socket.write('{"operation":"readCounters"}\n'));
      socket.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_REPLY_BYTES) {
          reject(new Error('Proxy counter reply exceeds bound'));
          socket.destroy();
          return;
        }
        chunks.push(chunk);
      });
      socket.once('end', () => {
        ended = true;
        if (bytes > MAX_REPLY_BYTES) {
          return;
        }
        try {
          resolve(parseProxyCounters(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))));
        } catch (error) {
          reject(error);
        }
      });
      socket.once('close', () => {
        if (!ended) {
          reject(new Error('Proxy counter connection closed before reply'));
        }
      });
    });
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}
