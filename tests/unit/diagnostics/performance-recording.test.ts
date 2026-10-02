import { expect, test, vi } from 'vitest';
import { ClientPerformanceMetrics } from '../../../src/diagnostics/performanceMetrics';

test('applied snapshot clocks survive interval drains and clear only with their session', () => {
  const recorder = new ClientPerformanceMetrics(true);
  const snapshot = {
    ownerId: 'pilot',
    sequence: 10,
    kind: 'keyframe' as const,
    gameTime: 60,
    serverTime: 1000,
  };
  recorder.snapshotApplied(snapshot);
  snapshot.gameTime = 0;
  const first = recorder.read(true);
  expect(first.lastSnapshot).toEqual({
    sequence: 10,
    kind: 'keyframe',
    gameTime: 60,
    serverTime: 1000,
  });
  expect(first.snapshotSession).toBe(0);
  expect(recorder.read().lastSnapshot).toEqual(first.lastSnapshot);
  if (first.lastSnapshot) {
    first.lastSnapshot.serverTime = 0;
  }
  expect(recorder.read().lastSnapshot?.serverTime).toBe(1000);
  recorder.resetSnapshotWitness();
  expect(recorder.read()).toMatchObject({
    lastSnapshot: undefined,
    lastKeyframeSequence: 0,
    snapshotSession: 1,
  });
});

test('transient applied worlds retain every owner and session across drains and resets', () => {
  vi.spyOn(performance, 'now').mockReturnValue(500);
  const recorder = new ClientPerformanceMetrics(true);
  const snapshot = {
    ownerId: 'pilot-a',
    sequence: 1,
    kind: 'keyframe' as const,
    gameTime: 60,
    serverTime: 1000,
  };
  recorder.snapshotApplied(snapshot);
  snapshot.ownerId = 'mutated';
  snapshot.gameTime = 0;
  recorder.snapshotApplied({
    ownerId: 'pilot-a',
    sequence: 2,
    kind: 'delta',
    gameTime: 61,
    serverTime: 1017,
  });
  recorder.resetSnapshotWitness();
  // Resetting transport cannot silently erase worlds applied earlier in this interval.
  recorder.snapshotApplied({
    ownerId: 'pilot-a',
    sequence: 1,
    kind: 'keyframe',
    gameTime: 70,
    serverTime: 1200,
  });
  const drained = recorder.read(true);
  expect(drained.appliedSnapshots).toEqual({
    count: 3,
    omittedSamples: 0,
    values: [
      {
        appliedAt: 500,
        ownerId: 'pilot-a',
        session: 0,
        sequence: 1,
        kind: 'keyframe',
        gameTime: 60,
        serverTime: 1000,
      },
      {
        appliedAt: 500,
        ownerId: 'pilot-a',
        session: 0,
        sequence: 2,
        kind: 'delta',
        gameTime: 61,
        serverTime: 1017,
      },
      {
        appliedAt: 500,
        ownerId: 'pilot-a',
        session: 1,
        sequence: 1,
        kind: 'keyframe',
        gameTime: 70,
        serverTime: 1200,
      },
    ],
  });
  const first = drained.appliedSnapshots.values[0];
  expect(first).toBeDefined();
  if (first) {
    first.ownerId = 'changed-after-drain';
  }
  expect(recorder.read().appliedSnapshots).toEqual({ count: 0, omittedSamples: 0, values: [] });
  expect(recorder.read().lastSnapshot?.gameTime).toBe(70);
  recorder.snapshotApplied({
    ownerId: undefined,
    sequence: 2,
    kind: 'delta',
    gameTime: 71,
    serverTime: undefined,
  });
  const read = recorder.read();
  expect(read.appliedSnapshots.values[0]).toMatchObject({
    ownerId: undefined,
    serverTime: undefined,
  });
  if (read.appliedSnapshots.values[0]) {
    read.appliedSnapshots.values[0].sequence = 0;
  }
  expect(recorder.read().appliedSnapshots.values[0]?.sequence).toBe(2);
  vi.restoreAllMocks();
});

test('applied world receipts remain bounded and expose all omissions without collecting in ordinary play', () => {
  const recorder = new ClientPerformanceMetrics(true);
  const ordinary = new ClientPerformanceMetrics(false);
  for (let sequence = 1; sequence <= 5000; sequence++) {
    const snapshot = {
      ownerId: 'pilot',
      sequence,
      kind: 'delta' as const,
      gameTime: sequence,
      serverTime: sequence * 17,
    };
    recorder.snapshotApplied(snapshot);
    ordinary.snapshotApplied(snapshot);
  }
  expect(recorder.read().appliedSnapshots).toMatchObject({ count: 5000, omittedSamples: 904 });
  expect(recorder.read().appliedSnapshots.values).toHaveLength(4096);
  expect(ordinary.read().appliedSnapshots).toEqual({ count: 0, omittedSamples: 0, values: [] });
  expect(ordinary.read().lastSnapshot?.sequence).toBe(5000);
});

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
  recorder.recordRendererFrame('webgl2');
  expect(recorder.read()).toMatchObject({ metrics: {}, counters: {}, pendingJoin: false });
  expect(recorder.read().renderer.frames).toEqual({ canvas: 0, webgl2: 0 });
});

test('a GPU recording keeps fallback frames visible and reads resource observations only on export', () => {
  const recorder = new ClientPerformanceMetrics(true);
  const observe = vi.fn(() => ({ backend: 'webgl2' as const, gpuStats: null }));
  recorder.setRendererObservation('webgl2', observe);
  recorder.recordRendererFrame('webgl2');
  recorder.recordRendererFrame('canvas');
  recorder.recordRendererFrame('webgl2');
  expect(observe).not.toHaveBeenCalled();
  const interval = recorder.read(true);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(interval.renderer).toEqual({
    requested: 'webgl2',
    backend: 'webgl2',
    frames: { canvas: 1, webgl2: 2 },
    gpuStats: null,
  });
  expect(recorder.read().renderer.frames).toEqual({ canvas: 0, webgl2: 0 });
  expect(interval.renderer.frames).toEqual({ canvas: 1, webgl2: 2 });
  recorder.setRendererObservation('canvas', null);
  recorder.read();
  expect(observe).toHaveBeenCalledTimes(2);
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
