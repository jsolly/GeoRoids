import assert from 'node:assert/strict';
import process from 'node:process';
import { type BenchmarkCompressionMode, isBenchmarkCompressionMode } from './websocket-compression';

export interface ServerProcessUsage {
  /** Cumulative CPU microseconds for the entire server process, including zlib workers. */
  user: number;
  system: number;
  /** Node's monotonic process clock in milliseconds; independent of the simulation clock. */
  monotonicMs: number;
  compression: BenchmarkCompressionMode;
}

/** Strict private-IPC boundary: no missing fields, coercion, or unbounded extra data. */
export function parseServerProcessUsage(value: unknown): ServerProcessUsage {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Invalid server process usage'
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    ['compression', 'monotonicMs', 'system', 'user'],
    'Invalid server process usage fields'
  );
  assert(
    'user' in value &&
      typeof value.user === 'number' &&
      Number.isSafeInteger(value.user) &&
      value.user >= 0 &&
      'system' in value &&
      typeof value.system === 'number' &&
      Number.isSafeInteger(value.system) &&
      value.system >= 0 &&
      'monotonicMs' in value &&
      typeof value.monotonicMs === 'number' &&
      Number.isFinite(value.monotonicMs) &&
      value.monotonicMs >= 0 &&
      value.monotonicMs <= Number.MAX_SAFE_INTEGER &&
      'compression' in value &&
      isBenchmarkCompressionMode(value.compression),
    'Invalid server process usage values'
  );
  return {
    user: value.user,
    system: value.system,
    monotonicMs: value.monotonicMs,
    compression: value.compression,
  };
}

/** O(1) measurement boundary; this does not read or advance any world state. */
export function captureServerProcessUsage(
  compression: BenchmarkCompressionMode
): ServerProcessUsage {
  const cpu = process.cpuUsage();
  return parseServerProcessUsage({ ...cpu, monotonicMs: performance.now(), compression });
}
