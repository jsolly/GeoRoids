import { expect, test } from 'vitest';
import type { ProxyCounters } from '../../../benchmarks/proxy-control';
import type { ServerProcessUsage } from '../../../benchmarks/server-process-usage';
import {
  measureProxyTransport,
  measureServerProcessCpu,
  requireNegotiatedCompression,
} from '../../../benchmarks/transport-qualification';

test.each(['deflate-level1-no-context', 'deflate-level1-no-context-8k'] as const)(
  'a %s candidate proves both no-context directions in its actual browser handshake',
  (mode) => {
    expect(() => requireNegotiatedCompression('none', '')).not.toThrow();
    expect(() => requireNegotiatedCompression('none', 'permessage-deflate')).toThrow();
    const actual = 'permessage-deflate; server_no_context_takeover; client_no_context_takeover';
    expect(() => requireNegotiatedCompression(mode, actual)).not.toThrow();
    expect(() =>
      requireNegotiatedCompression(mode, `${actual}; server_max_window_bits=15`)
    ).not.toThrow();
    for (const header of [
      '',
      'permessage-deflate',
      `${actual}; server_max_window_bits=14`,
      `${actual}; client_no_context_takeover`,
      `${actual}, another-extension`,
    ]) {
      expect(() => requireNegotiatedCompression(mode, header)).toThrow();
    }
  }
);

function proxyBoundaries() {
  const start: ProxyCounters = {
    instanceId: '9772d870-e0d6-41db-b042-5073c14a5071',
    profile: 'clean',
    monotonicMs: 1000,
    bytesUp: 4000,
    bytesDown: 250000,
    peakWritableBytes: 65536,
    peakPendingDeliveryBytes: 131072,
    failures: 0,
    activeSockets: 10,
    pendingTimers: 4,
  };
  const end: ProxyCounters = {
    ...start,
    monotonicMs: 3000,
    bytesUp: 6400,
    bytesDown: 350000,
    peakWritableBytes: 131072,
    peakPendingDeliveryBytes: 196608,
    activeSockets: 6,
    pendingTimers: 0,
  };
  return { start, end };
}

test('each TCP window subtracts warmup totals and uses the proxy clock while retaining crossing-byte scope', () => {
  const { start, end } = proxyBoundaries();
  const measured = measureProxyTransport({ start, end, profile: 'clean' });
  expect(measured).toMatchObject({
    instanceId: start.instanceId,
    profile: 'clean',
    start,
    end,
    wallMs: 2000,
    bytesUp: 2400,
    bytesDown: 100000,
    totalBytes: 102400,
    upBytesPerSecond: 1200,
    downBytesPerSecond: 50000,
  });
  expect(measured.scope).toContain('WebSocket/HTTP framing');
  expect(measured.scope).toContain('in-flight warmup');
  expect(measured.scope).toContain('excludes TCP/IP');
  expect(measured.peakPolicy).toContain('not measured-window maxima');
  // Connection/timer gauges can fall without a cumulative byte regression.
  expect(measured.end.activeSockets).toBeLessThan(measured.start.activeSockets);
  expect(measured.end.pendingTimers).toBe(0);
});

test('TCP windows reject a different owned proxy, a different lane, failed transport or absent traffic', () => {
  const { start, end } = proxyBoundaries();
  for (const invalid of [
    { ...end, instanceId: '5976fcae-2923-4121-a97d-1b6a6bb4c0cf' },
    { ...end, profile: 'degraded' as const },
    { ...end, failures: 1 },
    { ...end, bytesUp: start.bytesUp },
    { ...end, bytesDown: start.bytesDown },
    { ...end, bytesUp: start.bytesUp - 1 },
    { ...end, bytesDown: start.bytesDown - 1 },
    { ...end, peakWritableBytes: start.peakWritableBytes - 1 },
    { ...end, peakPendingDeliveryBytes: start.peakPendingDeliveryBytes - 1 },
  ]) {
    expect(() => measureProxyTransport({ start, end: invalid, profile: 'clean' })).toThrow(
      'Proxy transport boundary'
    );
  }
  expect(() =>
    measureProxyTransport({ start: { ...start, instanceId: '' }, end, profile: 'clean' })
  ).toThrow();
  expect(() =>
    measureProxyTransport({
      start: { ...start, failures: 1 },
      end: { ...end, failures: 1 },
      profile: 'clean',
    })
  ).toThrow();
  expect(() => measureProxyTransport({ start, end, profile: 'normal' })).toThrow();
});

test('TCP windows reject invalid clocks and unsafe cumulative byte arithmetic in either boundary', () => {
  const { start, end } = proxyBoundaries();
  for (const invalid of [
    { ...end, monotonicMs: start.monotonicMs },
    { ...end, monotonicMs: start.monotonicMs - 1 },
    { ...end, monotonicMs: Number.NaN },
    { ...end, monotonicMs: Number.POSITIVE_INFINITY },
    { ...end, monotonicMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...end, bytesUp: end.bytesUp + 0.5 },
    { ...end, bytesDown: Number.NaN },
    { ...end, bytesDown: Number.MAX_SAFE_INTEGER + 1 },
    { ...end, bytesUp: Number.MAX_SAFE_INTEGER, bytesDown: Number.MAX_SAFE_INTEGER },
  ]) {
    expect(() => measureProxyTransport({ start, end: invalid, profile: 'clean' })).toThrow();
  }
  for (const invalid of [
    { ...start, monotonicMs: -1 },
    { ...start, bytesUp: -1 },
    { ...start, bytesDown: Number.NaN },
    { ...start, peakWritableBytes: start.peakWritableBytes + 0.5 },
  ]) {
    expect(() => measureProxyTransport({ start: invalid, end, profile: 'clean' })).toThrow();
  }
});

test('total server process CPU retains worker usage and fails on regressed or changed boundaries', () => {
  const start: ServerProcessUsage = {
    user: 1000,
    system: 100,
    monotonicMs: 10,
    compression: 'none',
  };
  const end: ServerProcessUsage = {
    user: 2_001_000,
    system: 100_100,
    monotonicMs: 1010,
    compression: 'none',
  };
  const receipt = measureServerProcessCpu(start, end);
  expect(receipt.totalMicroseconds).toBe(2_100_000);
  expect(receipt.utilizationPercent).toBe(210);
  expect(receipt.start).toEqual(start);
  expect(receipt.end).toEqual(end);
  for (const invalid of [
    { ...end, user: 0 },
    { ...end, system: 0 },
    { ...end, monotonicMs: 10 },
    { ...end, monotonicMs: Number.NaN },
    { ...end, compression: 'deflate-level1-no-context' as const },
    { ...end, compression: 'deflate-level1-no-context-8k' as const },
  ]) {
    expect(() => measureServerProcessCpu(start, invalid)).toThrow();
  }
  const largerStart = { ...start, compression: 'deflate-level1-no-context-8k' as const };
  const largerEnd = { ...end, compression: 'deflate-level1-no-context-8k' as const };
  const largerReceipt = measureServerProcessCpu(largerStart, largerEnd);
  expect(largerReceipt.compression).toBe('deflate-level1-no-context-8k');
  expect(largerReceipt.totalMicroseconds).toBe(receipt.totalMicroseconds);
  expect(() =>
    measureServerProcessCpu(largerStart, { ...largerEnd, compression: 'deflate-level1-no-context' })
  ).toThrow('changed compression mode');
});
