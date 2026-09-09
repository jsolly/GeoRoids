import assert from 'node:assert/strict';

export interface Measurement {
  primaryMetric: string;
  samples: Record<string, number[]>;
  counts: Record<string, number>;
  parameters: object;
  witness: object;
  cleanup: 'complete';
}

export interface MeasurementPair {
  a: Measurement;
  b: Measurement;
}

/** Stable JSON makes outcome comparison independent of property insertion order. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function normalize(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return item;
    }
    if (typeof item === 'number') {
      assert(Number.isFinite(item), 'Report contains a non-finite number');
      return item;
    }
    assert(item && typeof item === 'object', 'Report contains a non-JSON value');
    assert(!ancestors.has(item), 'Report contains a cycle');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        return item.map(normalize);
      }
      assert(isRecord(item), 'Report contains a non-JSON object');
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key])])
      );
    } finally {
      ancestors.delete(item);
    }
  }
  return JSON.stringify(normalize(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

export function validateMeasurement(result: unknown): asserts result is Measurement {
  assert(isRecord(result), 'Measurement must be an object');
  assert.equal(result['cleanup'], 'complete', 'Measurement cleanup did not complete');
  const samplesByMetric = result['samples'];
  const primaryMetric = result['primaryMetric'];
  assert(isRecord(samplesByMetric), 'Measurement samples are missing');
  assert(
    typeof primaryMetric === 'string' && Object.hasOwn(samplesByMetric, primaryMetric),
    'Primary metric is missing'
  );
  for (const [name, samples] of Object.entries(samplesByMetric)) {
    assert(Array.isArray(samples) && samples.length > 0, `${name} has no samples`);
    assert(
      samples.every(
        (sample: unknown) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0
      ),
      `${name} has invalid samples`
    );
  }
  const counts = result['counts'];
  assert(isRecord(counts) && Object.keys(counts).length > 0, 'Measurement has no work counts');
  for (const [name, value] of Object.entries(counts)) {
    assert(
      typeof value === 'number' && Number.isFinite(value) && value >= 0,
      `${name} has an invalid count`
    );
  }
  assert(isRecord(result['parameters']), 'Measurement parameters are missing');
  assert(isRecord(result['witness']), 'Measurement outcome witness is missing');
  canonicalJson(result);
}

export function mean(values: readonly number[]): number {
  assert(values.length > 0, 'Cannot average an empty sample');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metricMean(result: Measurement): number {
  const samples = result.samples[result.primaryMetric];
  assert(samples, 'Primary metric is missing');
  const average = mean(samples);
  assert(average > 0, 'Primary timing metric must have a positive mean');
  return average;
}

/** Fixed seeded resampling gives a reproducible descriptive interval, not a capacity guarantee. */
function pairedInterval(pairs: readonly MeasurementPair[], seed: number) {
  const ratios = pairs.map(({ a, b }) => Math.log(metricMean(b) / metricMean(a)));
  let state = seed >>> 0;
  const estimates: number[] = [];
  for (let sample = 0; sample < 2000; sample++) {
    let sum = 0;
    for (let draw = 0; draw < ratios.length; draw++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const value = ratios[Math.floor((state / 2 ** 32) * ratios.length)];
      assert(value !== undefined);
      sum += value;
    }
    estimates.push((Math.exp(sum / ratios.length) - 1) * 100);
  }
  estimates.sort((a, b) => a - b);
  const low = estimates[50];
  const high = estimates[1949];
  assert(low !== undefined && high !== undefined);
  return { changePercent: (Math.exp(mean(ratios)) - 1) * 100, low, high };
}

export function compareMeasurements(
  calibration: readonly MeasurementPair[],
  pairs: readonly MeasurementPair[],
  seed: number
) {
  assert.equal(calibration.length, 3, 'Comparison requires exactly three A/A calibration pairs');
  assert.equal(pairs.length, 12, 'Comparison requires exactly twelve A/B pairs');
  assert(Number.isSafeInteger(seed), 'Bootstrap seed must be a safe integer');
  const reference = pairs[0]?.a;
  assert(reference);
  for (const pair of [...calibration, ...pairs]) {
    for (const result of [pair.a, pair.b]) {
      validateMeasurement(result);
      assert.equal(result.primaryMetric, reference.primaryMetric, 'Primary metrics differ');
      assert.equal(
        canonicalJson(result.parameters),
        canonicalJson(reference.parameters),
        'Workload parameters differ'
      );
      assert.equal(
        canonicalJson(result.witness),
        canonicalJson(reference.witness),
        'Scenario outcomes differ'
      );
    }
  }
  for (const { a, b } of calibration) {
    assert.equal(
      canonicalJson(a.counts),
      canonicalJson(b.counts),
      'A/A work counts are not repeatable'
    );
    assert.equal(
      canonicalJson(a.counts),
      canonicalJson(reference.counts),
      'Baseline work counts changed'
    );
  }
  const candidate = pairs[0]?.b;
  assert(candidate);
  for (const { a, b } of pairs) {
    assert.equal(
      canonicalJson(a.counts),
      canonicalJson(reference.counts),
      'Baseline work counts are not repeatable'
    );
    assert.equal(
      canonicalJson(b.counts),
      canonicalJson(candidate.counts),
      'Candidate work counts are not repeatable'
    );
  }
  const noise = pairedInterval(calibration, seed);
  const timing = pairedInterval(pairs, seed);
  const calibrationStable = noise.low <= 0 && noise.high >= 0;
  const timingVerdict = !calibrationStable
    ? 'inconclusive: calibration drift'
    : timing.low <= 0 && timing.high >= 0
      ? 'inconclusive'
      : timing.high < 0
        ? 'lower measured time'
        : 'higher measured time';
  return {
    primaryMetric: reference.primaryMetric,
    calibration: { ...noise, stable: calibrationStable },
    timing: { ...timing, verdict: timingVerdict },
    work: { baseline: reference.counts, candidate: candidate.counts },
    interpretation:
      'Paired timing interval is descriptive. Work counts are exact for this fixture; timings depend on the machine and scheduling.',
  };
}
