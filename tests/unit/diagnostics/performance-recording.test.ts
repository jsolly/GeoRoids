import { expect, test } from 'vitest';
import { ClientPerformanceMetrics } from '../../../src/diagnostics/performanceMetrics';

test('long sessions retain bounded samples while accounting for every slow frame', () => {
  const recorder = new ClientPerformanceMetrics(true);
  recorder.setPhase('play');
  for (let i = 0; i < 5000; i++) {
    recorder.record('frameIntervalMs', 40);
  }
  const samples = recorder.read().metrics['play.frameIntervalMs'];
  expect(samples).toMatchObject({
    count: 5000,
    omittedSamples: 904,
    over33Ms: 5000,
    sum: 200000,
    max: 40,
  });
  expect(samples?.values).toHaveLength(4096);
  recorder.read(true);
  expect(recorder.read().metrics).toEqual({});
});

test('input latency retains the earliest event and separates hidden recovery from play', () => {
  const recorder = new ClientPerformanceMetrics(true);
  recorder.setPhase('play');
  recorder.input(100);
  recorder.input(110);
  recorder.rendered(125);
  recorder.rendered(130);
  expect(recorder.read().metrics['play.inputToRenderMs']?.values).toEqual([25]);
  recorder.join(140);
  recorder.setPhase('hidden');
  recorder.input(145);
  recorder.recover(200);
  recorder.setPhase('play');
  recorder.stateApplied();
  recorder.rendered(250);
  expect(recorder.read().metrics['play.recoveryMs']?.values).toEqual([50]);
  expect(recorder.read().metrics['play.joinMs']?.values).toEqual([110]);
  expect(recorder.read().counters).toEqual({
    inputEvents: 2,
    joinAttempts: 1,
    recoveryAttempts: 1,
  });
});

test('ordinary sessions collect no performance observations', () => {
  const recorder = new ClientPerformanceMetrics(false);
  recorder.setPhase('play');
  recorder.join(0);
  recorder.input(2);
  recorder.rendered(10);
  recorder.record('frameCpuMs', 3);
  recorder.count('messageFailures');
  expect(recorder.read()).toMatchObject({ metrics: {}, counters: {}, pendingJoin: false });
});

test('failed joins, reconnect exhaustion and invalid measurements remain in the report', () => {
  const recorder = new ClientPerformanceMetrics(true);
  recorder.join(100);
  recorder.joinFailed();
  recorder.joinFailed();
  recorder.recover(200);
  recorder.recover(300);
  recorder.stateApplied();
  recorder.rendered(350);
  expect(recorder.read().metrics['menu.recoveryMs']?.values).toEqual([150]);
  recorder.recover(400);
  recorder.recoveryFailed();
  recorder.record('renderMs', Number.NaN);
  recorder.record('renderMs', -1);
  recorder.record('renderMs', Number.POSITIVE_INFINITY);
  expect(recorder.read()).toMatchObject({
    pendingJoin: false,
    pendingRecovery: false,
    counters: {
      joinAttempts: 1,
      joinFailures: 1,
      recoveryAttempts: 2,
      recoveryFailures: 1,
      invalidSamples: 3,
    },
  });
});

test('intentional teardown cancels recovery without reporting a failure', () => {
  const recorder = new ClientPerformanceMetrics(true);
  recorder.recover(100);
  recorder.cancelRecovery();

  expect(recorder.read()).toMatchObject({
    pendingRecovery: false,
    counters: { recoveryAttempts: 1 },
  });
  expect(recorder.read().counters['recoveryFailures']).toBeUndefined();
});

test('heartbeat observations distinguish successful, repeated, missing and legacy replies', () => {
  const recorder = new ClientPerformanceMetrics(true);
  const first = recorder.probe(10);
  recorder.pong(first, 40);
  recorder.pong(first, 45);
  recorder.probe(50);
  recorder.clearProbes();
  recorder.pong(999, 70);
  recorder.pong(undefined, 80);
  expect(recorder.read().metrics['menu.rttMs']?.values).toEqual([30]);
  expect(recorder.read().counters).toMatchObject({
    duplicatePongs: 1,
    unansweredProbes: 1,
    stalePongs: 1,
    barePongs: 1,
  });
});

test('UTF-8 payload sizes and release/cancel observations survive interval drains', () => {
  const recorder = new ClientPerformanceMetrics(true);
  recorder.setPhase('play');
  recorder.message('snapshot', 'é', 10);
  recorder.message('snapshot', 'x', 30);
  recorder.input(10, 'release');
  recorder.input(11, 'cancel');
  recorder.rendered(20);
  const interval = recorder.read(true);
  expect(interval.schemaVersion).toBe(2);
  expect(interval.messageBytes).toEqual({ snapshot: 3 });
  expect(interval.metrics['play.messageGapMs']?.values).toEqual([20]);
  expect(interval.metrics['play.inputToRenderMs']).toBeUndefined();
  expect(interval.counters).toMatchObject({ inputReleases: 1, inputCancellations: 1 });
  expect(
    Object.values(interval.phaseDurationsMs).reduce((sum, duration) => sum + duration, 0)
  ).toBeCloseTo(interval.durationMs, 0);
  expect(recorder.read().messageBytes).toEqual({});
});

test('a phone recording owns destructive drains while inspection remains available', () => {
  const recorder = new ClientPerformanceMetrics(true);
  recorder.record('renderMs', 3);
  recorder.claimDrain('phone');
  expect(recorder.read().metrics['menu.renderMs']?.count).toBe(1);
  expect(() => recorder.read(true)).toThrow('Performance drain owned by phone');
  expect(() => recorder.claimDrain('benchmark')).toThrow('Performance drain owned by phone');
  expect(recorder.read(true, 'phone').metrics['menu.renderMs']?.count).toBe(1);
  recorder.releaseDrain('benchmark');
  expect(() => recorder.read(true)).toThrow();
  recorder.releaseDrain('phone');
  expect(() => recorder.read(true)).not.toThrow();
});
