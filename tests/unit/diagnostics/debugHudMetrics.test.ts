import { afterEach, expect, test } from 'vitest';

import {
  noteDebugFrame,
  noteDebugPingSent,
  noteDebugPong,
  noteDebugSnapshot,
  readDebugHudMetrics,
  resetDebugHudMetricsForTests,
  shortReleaseId,
} from '../../../src/diagnostics/debugHudMetrics';

afterEach(() => {
  resetDebugHudMetricsForTests();
});

test('smoothed FPS appears after a few honest frame intervals', () => {
  expect(readDebugHudMetrics(0).fps).toBeUndefined();
  noteDebugFrame(16.6);
  noteDebugFrame(16.7);
  noteDebugFrame(16.5);
  const fps = readDebugHudMetrics(50).fps;
  expect(fps).toBeGreaterThan(55);
  expect(fps).toBeLessThan(65);
});

test('RTT is the time from the last ping send to its pong', () => {
  noteDebugPingSent(1000);
  noteDebugPong(1028);
  expect(readDebugHudMetrics(1030).rttMs).toBe(28);
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
