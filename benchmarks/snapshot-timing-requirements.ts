import assert from 'node:assert/strict';
import { APPLIED_SNAPSHOT_SAMPLE_LIMIT } from '../src/diagnostics/performanceMetrics';

type Phase = 'join' | 'warmup' | 'measured';
const CLIENT_PHASES = new Set(['menu', 'play', 'respawn', 'hidden']);
const MAX_INTERVALS = 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function integer(value: unknown): value is number {
  return nonnegative(value) && Number.isSafeInteger(value);
}

function timingCount(metrics: Record<string, unknown>, kind: 'keyframe' | 'delta'): number {
  let count = 0;
  const suffix = `.${kind}DecodeMs`;
  for (const [name, value] of Object.entries(metrics)) {
    if (!name.endsWith(suffix)) {
      continue;
    }
    assert(CLIENT_PHASES.has(name.slice(0, -suffix.length)), 'Unknown snapshot timing phase');
    assert(record(value), 'Missing snapshot timing series');
    assert(
      integer(value['count']) &&
        value['omittedSamples'] === 0 &&
        Array.isArray(value['values']) &&
        value['values'].length <= APPLIED_SNAPSHOT_SAMPLE_LIMIT &&
        value['count'] === value['values'].length,
      'Missing, malformed or omitted snapshot timing samples'
    );
    for (const sample of value['values']) {
      assert(nonnegative(sample), 'Missing, malformed or omitted snapshot timing samples');
    }
    count += value['count'];
  }
  return count;
}

/** Successful applications require their own phase's real decode samples, never invented zeroes. */
export function validateSnapshotTimingRequirements(phases: unknown): {
  appliedKeyframes: number;
  appliedDeltas: number;
} {
  assert(
    Array.isArray(phases) && phases.length > 0 && phases.length <= 3,
    'Missing snapshot timing phases'
  );
  const seen = new Set<Phase>();
  let measuredIntervals = 0;
  let appliedKeyframes = 0;
  let appliedDeltas = 0;
  for (const phase of phases) {
    assert(record(phase), 'Malformed snapshot timing phase');
    const name = phase['phase'];
    assert(
      name === 'join' || name === 'warmup' || name === 'measured',
      'Unknown snapshot timing phase'
    );
    assert(!seen.has(name), 'Duplicate snapshot timing phase');
    seen.add(name);
    assert(
      Array.isArray(phase['intervals']) && phase['intervals'].length <= MAX_INTERVALS,
      'Missing or unbounded snapshot timing intervals'
    );
    for (const interval of phase['intervals']) {
      assert(record(interval) && record(interval['metrics']), 'Missing snapshot metrics');
      assert(
        typeof interval['phase'] === 'string' && CLIENT_PHASES.has(interval['phase']),
        'Unknown client phase'
      );
      const applied = interval['appliedSnapshots'];
      assert(record(applied), 'Missing measured applied-snapshot witness');
      assert(
        integer(applied['count']) &&
          applied['omittedSamples'] === 0 &&
          Array.isArray(applied['values']) &&
          applied['values'].length <= APPLIED_SNAPSHOT_SAMPLE_LIMIT &&
          applied['count'] === applied['values'].length,
        'Malformed or omitted measured applied-snapshot witness'
      );
      const counts = { keyframe: 0, delta: 0 };
      for (const snapshot of applied['values']) {
        assert(record(snapshot), 'Malformed measured applied-snapshot witness');
        const kind = snapshot['kind'];
        assert(kind === 'keyframe' || kind === 'delta', 'Unknown measured applied-snapshot kind');
        assert(
          typeof snapshot['ownerId'] === 'string' &&
            snapshot['ownerId'].length > 0 &&
            snapshot['ownerId'].length <= 256 &&
            integer(snapshot['session']) &&
            integer(snapshot['sequence']) &&
            snapshot['sequence'] > 0 &&
            nonnegative(snapshot['appliedAt']) &&
            nonnegative(snapshot['gameTime']) &&
            (snapshot['serverTime'] === undefined || nonnegative(snapshot['serverTime'])),
          'Malformed measured applied-snapshot identity or clock'
        );
        counts[kind]++;
      }
      for (const kind of ['keyframe', 'delta'] as const) {
        const timed = timingCount(interval['metrics'], kind);
        if (name === 'measured') {
          assert.equal(
            timed,
            counts[kind],
            `Measured ${kind} decode timing count differs from successful applications`
          );
        }
      }
      if (name === 'measured') {
        measuredIntervals++;
        appliedKeyframes += counts.keyframe;
        appliedDeltas += counts.delta;
      }
    }
  }
  assert(
    measuredIntervals > 0 && appliedKeyframes + appliedDeltas > 0,
    'Missing measured successful snapshot applications'
  );
  return { appliedKeyframes, appliedDeltas };
}
