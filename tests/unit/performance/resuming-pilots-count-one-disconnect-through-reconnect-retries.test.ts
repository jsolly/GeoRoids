import { expect, test } from 'vitest';
import { ClientPerformanceMetrics } from '../../../src/diagnostics/performanceMetrics';

test('a returning pilot counts its disconnected socket even when visibility recovery starts first', () => {
  const metrics = new ClientPerformanceMetrics(true);
  metrics.recover(100);
  metrics.reconnect(1, 110);
  metrics.reconnect(2, 120);
  const report = metrics.read();
  expect(report.pendingRecovery).toBe(true);
  expect(report.counters['disconnects']).toBe(1);
  expect(report.counters['recoveryAttempts']).toBe(1);
});

test('a disconnected pilot counts the same recovery when transport notification precedes visibility', () => {
  const metrics = new ClientPerformanceMetrics(true);
  metrics.reconnect(1, 100);
  metrics.recover(110);
  metrics.reconnect(2, 120);
  const report = metrics.read();
  expect(report.counters['disconnects']).toBe(1);
  expect(report.counters['recoveryAttempts']).toBe(1);
});
