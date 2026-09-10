import { describe, expect, it } from 'vitest';
import {
  compareMeasurements,
  type Measurement,
  validateMeasurement,
} from '../../../benchmarks/results';

function sample(milliseconds: number): Measurement {
  return {
    primaryMetric: 'tickMs',
    samples: { tickMs: [milliseconds, milliseconds] },
    counts: { ticks: 120, encodedBytes: 4000 },
    parameters: { seed: 42, players: 2 },
    witness: { players: ['pilot-a', 'pilot-b'], tick: 120, alive: 2 },
    cleanup: 'complete',
  };
}

function comparison() {
  return {
    calibration: [
      { a: sample(10), b: sample(9) },
      { a: sample(10), b: sample(10) },
      { a: sample(10), b: sample(11) },
    ],
    pairs: Array.from({ length: 12 }, () => ({ a: sample(10), b: sample(8) })),
  };
}

describe('comparing the same multiplayer workload', () => {
  it('reports lower measured time and exact byte changes when outcomes stay equal', () => {
    const { calibration, pairs } = comparison();
    for (const { b } of pairs) {
      b.counts['encodedBytes'] = 3000;
    }
    const result = compareMeasurements(calibration, pairs, 42);
    expect(result.calibration.stable).toBe(true);
    expect(result.timing.verdict).toBe('lower measured time');
    expect(result.timing.changePercent).toBeCloseTo(-20);
    expect(result.work).toEqual({
      baseline: { ticks: 120, encodedBytes: 4000 },
      candidate: { ticks: 120, encodedBytes: 3000 },
    });
  });

  it('refuses a faster run that lost a pilot or changed its input workload', () => {
    const { calibration, pairs } = comparison();
    const first = pairs[0];
    if (!first) {
      throw new Error('Comparison fixture is empty');
    }
    first.b.witness = { players: ['pilot-a'], tick: 120, alive: 1 };
    expect(() => compareMeasurements(calibration, pairs, 42)).toThrow('Scenario outcomes differ');
    first.b.witness = sample(8).witness;
    first.b.parameters = { seed: 43, players: 2 };
    expect(() => compareMeasurements(calibration, pairs, 42)).toThrow('Workload parameters differ');
  });

  it('labels noisy timing or drifting A/A calibration inconclusive', () => {
    const { calibration, pairs } = comparison();
    for (const [index, pair] of pairs.entries()) {
      pair.b = sample(index % 2 === 0 ? 8 : 12.5);
    }
    expect(compareMeasurements(calibration, pairs, 42).timing.verdict).toBe('inconclusive');
    for (const pair of calibration) {
      pair.b = sample(8);
    }
    for (const pair of pairs) {
      pair.b = sample(8);
    }
    expect(compareMeasurements(calibration, pairs, 42).timing.verdict).toBe(
      'inconclusive: calibration drift'
    );
  });

  it('rejects incomplete runs and counts that cannot be reproduced', () => {
    const { calibration, pairs } = comparison();
    expect(() => compareMeasurements(calibration, pairs.slice(1), 42)).toThrow('exactly twelve');
    const first = pairs[0];
    if (!first) {
      throw new Error('Comparison fixture is empty');
    }
    first.b.counts['ticks'] = 119;
    expect(() => compareMeasurements(calibration, pairs, 42)).toThrow(
      'Candidate work counts are not repeatable'
    );
    expect(() => validateMeasurement({ ...sample(10), cleanup: 'failed' })).toThrow(
      'cleanup did not complete'
    );
    expect(() => validateMeasurement({ ...sample(10), samples: { tickMs: [] } })).toThrow(
      'no samples'
    );
    expect(() => validateMeasurement({ ...sample(10), samples: { tickMs: ['fast'] } })).toThrow(
      'invalid samples'
    );
  });
});
