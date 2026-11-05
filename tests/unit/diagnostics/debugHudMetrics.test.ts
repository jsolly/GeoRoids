import { afterEach, expect, test } from 'vitest';

import {
  noteDebugFrame,
  noteDebugPingSent,
  noteDebugPong,
  noteDebugSnapshot,
  readDebugHudMetrics,
  resetDebugHudMetricsForTests,
  resetDebugHudSession,
  shortReleaseId,
} from '../../../src/diagnostics/debugHudMetrics';

afterEach(() => {
  resetDebugHudMetricsForTests();
});

test('FPS counts rendered frames over elapsed foreground time', () => {
  expect(readDebugHudMetrics(0).fps).toBeUndefined();
  noteDebugFrame(16.6);
  noteDebugFrame(16.7);
  noteDebugFrame(16.5);
  const fps = readDebugHudMetrics(50).fps;
  expect(fps).toBeGreaterThan(55);
  expect(fps).toBeLessThan(65);
});

test('a long foreground stall lowers FPS instead of disappearing from the report', () => {
  for (let frame = 0; frame < 60; frame++) {
    noteDebugFrame(1000 / 60);
  }
  noteDebugFrame(500);
  expect(readDebugHudMetrics(1500).fps).toBeGreaterThanOrEqual(30);
  expect(readDebugHudMetrics(1500).fps).toBeLessThanOrEqual(32);
});

test('mixed fast and slow frames use a time-weighted rate rather than reciprocal averaging', () => {
  noteDebugFrame(10);
  noteDebugFrame(90);
  expect(readDebugHudMetrics(100).fps).toBe(20);
});

test('old stalls leave the bounded frame window after a second of smooth play', () => {
  noteDebugFrame(2000);
  expect(readDebugHudMetrics(2000).fps).toBe(1);
  for (let frame = 0; frame < 61; frame++) {
    noteDebugFrame(1000 / 60);
  }
  expect(readDebugHudMetrics(3017).fps).toBe(60);
  for (let frame = 0; frame < 600; frame++) {
    noteDebugFrame(1);
  }
  expect(readDebugHudMetrics(3617).fps).toBe(1000);
});

test('invalid frame intervals never replace valid frame evidence', () => {
  noteDebugFrame(50);
  for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    noteDebugFrame(interval);
  }
  expect(readDebugHudMetrics(50).fps).toBe(20);
});

test('RTT is the elapsed time for the matching pending ping', () => {
  noteDebugPingSent(1, 1000);
  noteDebugPong(1, 1028);
  expect(readDebugHudMetrics(1030).rttMs).toBe(28);
});

test('a delayed earlier reply cannot be measured from a newer ping', () => {
  noteDebugPingSent(1, 1000);
  noteDebugPingSent(2, 3000);
  noteDebugPong(1, 3100);
  expect(readDebugHudMetrics(3100).rttMs).toBeUndefined();
  noteDebugPong(2, 3120);
  expect(readDebugHudMetrics(3120).rttMs).toBe(120);
});

test('pending pings and duplicate replies retain the last valid latency', () => {
  noteDebugPingSent(1, 1000);
  noteDebugPong(1, 1028);
  noteDebugPingSent(2, 3000);
  expect(readDebugHudMetrics(3000).rttMs).toBe(28);
  noteDebugPong(1, 3100);
  expect(readDebugHudMetrics(3100).rttMs).toBe(28);
  noteDebugPong(2, 3120);
  noteDebugPong(2, 3200);
  expect(readDebugHudMetrics(3200).rttMs).toBe(120);
});

test.each([undefined, null, '1', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'a malformed or bare pong identity %s cannot complete a pending ping',
  (probeId) => {
    noteDebugPingSent(1, 1000);
    noteDebugPong(probeId, 1028);
    expect(readDebugHudMetrics(1030).rttMs).toBeUndefined();
    noteDebugPong(1, 1040);
    expect(readDebugHudMetrics(1040).rttMs).toBe(40);
  }
);

test.each([999, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  'an invalid reply time %s does not consume the pending probe',
  (now) => {
    noteDebugPingSent(1, 1000);
    noteDebugPong(1, now);
    expect(readDebugHudMetrics(1030).rttMs).toBeUndefined();
    noteDebugPong(1, 1040);
    expect(readDebugHudMetrics(1040).rttMs).toBe(40);
  }
);

test('a session reset clears displayed latency and rejects the previous pending reply', () => {
  noteDebugPingSent(1, 1000);
  noteDebugPong(1, 1028);
  noteDebugPingSent(2, 2000);
  noteDebugSnapshot(10, 2010);
  resetDebugHudSession();
  noteDebugPong(2, 2030);
  expect(readDebugHudMetrics(2030)).toMatchObject({
    rttMs: undefined,
    snapshotSequence: undefined,
    snapshotAgeMs: undefined,
  });
  noteDebugPingSent(3, 3000);
  noteDebugPong(2, 3010);
  expect(readDebugHudMetrics(3010).rttMs).toBeUndefined();
  noteDebugPong(3, 3040);
  expect(readDebugHudMetrics(3040).rttMs).toBe(40);
});

test('snapshot age is measured from the last accepted snapshot', () => {
  noteDebugSnapshot(1842, 5000);
  const sample = readDebugHudMetrics(5033);
  expect(sample.snapshotSequence).toBe(1842);
  expect(sample.snapshotAgeMs).toBe(33);
});

test('short release IDs stay readable and never invent a second correlator', () => {
  expect(shortReleaseId(undefined)).toBe('—');
  expect(shortReleaseId('dev')).toBe('dev');
  expect(shortReleaseId('a02282efc1d2e3f4a5b6c7d8e9f0aabbccddeeff')).toBe('a02282e');
});
