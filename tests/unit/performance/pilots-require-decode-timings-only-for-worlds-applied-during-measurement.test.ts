// @vitest-environment node
import { expect, test } from 'vitest';
import { validateSnapshotTimingRequirements } from '../../../benchmarks/snapshot-timing-requirements';
import { ClientPerformanceMetrics } from '../../../src/diagnostics/performanceMetrics';

type Kind = 'keyframe' | 'delta';

function interval(applied: readonly Kind[], timed: readonly Kind[] = applied) {
  const recorder = new ClientPerformanceMetrics(true);
  recorder.setPhase('play');
  for (const [index, kind] of timed.entries()) {
    recorder.record(`${kind}DecodeMs`, index + 0.25);
  }
  for (const [index, kind] of applied.entries()) {
    recorder.snapshotApplied({
      ownerId: 'measured-pilot',
      sequence: index + 1,
      kind,
      gameTime: index,
      serverTime: 1000 + index,
    });
  }
  return recorder.read(true);
}

test('a pilot with only measured deltas needs no fabricated keyframe decode sample', () => {
  const measured = interval(['delta', 'delta']);
  const phases = [
    { phase: 'join', intervals: [interval(['keyframe'])] },
    { phase: 'warmup', intervals: [interval(['keyframe', 'delta'])] },
    { phase: 'measured', intervals: [measured] },
  ];
  expect(validateSnapshotTimingRequirements(phases)).toEqual({
    appliedKeyframes: 0,
    appliedDeltas: 2,
  });
  expect(measured.metrics['play.keyframeDecodeMs']).toBeUndefined();
  expect(measured.metrics['play.deltaDecodeMs']?.values).toEqual([0.25, 1.25]);
});

test('a measured keyframe requires its own actual timing and cannot borrow warmup or join samples', () => {
  for (const phase of ['join', 'warmup']) {
    expect(() =>
      validateSnapshotTimingRequirements([
        { phase, intervals: [interval(['keyframe'])] },
        { phase: 'measured', intervals: [interval(['keyframe', 'delta'], ['delta'])] },
      ])
    ).toThrow('Measured keyframe decode timing count');
  }
});

test('every successfully applied kind retains exact finite measured decode samples', () => {
  const measured = interval(['keyframe', 'delta', 'delta']);
  expect(
    validateSnapshotTimingRequirements([{ phase: 'measured', intervals: [measured] }])
  ).toEqual({ appliedKeyframes: 1, appliedDeltas: 2 });
  expect(measured.metrics['play.keyframeDecodeMs']?.values).toEqual([0.25]);
  expect(measured.metrics['play.deltaDecodeMs']?.values).toEqual([1.25, 2.25]);
  const missingOne = interval(['keyframe', 'keyframe', 'delta'], ['keyframe', 'delta']);
  expect(() =>
    validateSnapshotTimingRequirements([{ phase: 'measured', intervals: [missingOne] }])
  ).toThrow('Measured keyframe decode timing count');
  const missingDelta = interval(['delta'], []);
  expect(() =>
    validateSnapshotTimingRequirements([{ phase: 'measured', intervals: [missingDelta] }])
  ).toThrow('Measured delta decode timing count');
});

test('absent, malformed, unknown or omitted application witnesses cannot excuse missing timings', () => {
  const valid = interval(['delta']);
  const receipt = valid.appliedSnapshots.values[0];
  expect(receipt).toBeDefined();
  const malformed = [
    { ...valid, appliedSnapshots: undefined },
    { ...valid, appliedSnapshots: { ...valid.appliedSnapshots, count: 2 } },
    { ...valid, appliedSnapshots: { ...valid.appliedSnapshots, omittedSamples: 1 } },
    ...[
      { ...receipt, kind: 'full' },
      { ...receipt, kind: undefined },
      { ...receipt, ownerId: undefined },
      { ...receipt, sequence: 0 },
      { ...receipt, session: -1 },
      { ...receipt, appliedAt: Number.NaN },
      { ...receipt, gameTime: -1 },
      { ...receipt, serverTime: Number.POSITIVE_INFINITY },
    ].map((snapshot) => ({
      ...valid,
      appliedSnapshots: { count: 1, omittedSamples: 0, values: [snapshot] },
    })),
  ];
  for (const candidate of malformed) {
    expect(() =>
      validateSnapshotTimingRequirements([{ phase: 'measured', intervals: [candidate] }])
    ).toThrow();
  }
  expect(() =>
    validateSnapshotTimingRequirements([{ phase: 'measured', intervals: [interval([])] }])
  ).toThrow('Missing measured successful snapshot applications');
  expect(() =>
    validateSnapshotTimingRequirements([{ phase: 'unknown', intervals: [valid] }])
  ).toThrow('Unknown snapshot timing phase');
  expect(() => validateSnapshotTimingRequirements([{ phase: 'measured', intervals: [] }])).toThrow(
    'Missing measured successful snapshot applications'
  );
});

test('warmup leakage, invalid sample values and timing retention loss fail measured qualification', () => {
  const valid = interval(['keyframe', 'delta']);
  const keyframes = valid.metrics['play.keyframeDecodeMs'];
  expect(keyframes).toBeDefined();
  for (const replacement of [
    { ...keyframes, omittedSamples: 1 },
    { ...keyframes, count: 2 },
    { ...keyframes, values: [Number.NaN] },
    { ...keyframes, values: [-1] },
    { ...keyframes, values: Array(1) },
  ]) {
    const candidate = {
      ...valid,
      metrics: { ...valid.metrics, 'play.keyframeDecodeMs': replacement },
    };
    expect(() =>
      validateSnapshotTimingRequirements([{ phase: 'measured', intervals: [candidate] }])
    ).toThrow('snapshot timing samples');
  }
  const leaked = interval(['delta'], ['keyframe', 'delta']);
  expect(() =>
    validateSnapshotTimingRequirements([{ phase: 'measured', intervals: [leaked] }])
  ).toThrow('Measured keyframe decode timing count');
  expect(() =>
    validateSnapshotTimingRequirements([{ phase: 'warmup', intervals: [valid] }])
  ).toThrow('Missing measured successful snapshot applications');
});
