import assert from 'node:assert/strict';

/** Retain numeric performance overruns without turning them into functional errors. */
export class PerformanceBudget {
  private readonly observations = new Map<
    string,
    {
      metric: string;
      direction: 'maximum' | 'minimum';
      limit: number;
      worst: number;
      samples: number;
      exceededSamples: number;
    }
  >();

  observe(
    metric: string,
    actual: number,
    limit: number,
    direction: 'maximum' | 'minimum' = 'maximum'
  ) {
    assert(Number.isFinite(actual) && actual >= 0, `Invalid measurement: ${metric}`);
    assert(Number.isFinite(limit) && limit >= 0, `Invalid performance budget: ${metric}`);
    const key = JSON.stringify([metric, direction, limit]);
    const observation = this.observations.get(key) ?? {
      metric,
      direction,
      limit,
      worst: actual,
      samples: 0,
      exceededSamples: 0,
    };
    observation.samples++;
    observation.worst =
      direction === 'maximum'
        ? Math.max(observation.worst, actual)
        : Math.min(observation.worst, actual);
    if (direction === 'maximum' ? actual > limit : actual < limit) {
      observation.exceededSamples++;
    }
    this.observations.set(key, observation);
  }

  report() {
    return {
      policy: 'report-only',
      observations: [...this.observations.values()].map((value) => ({
        ...value,
        delta: value.worst - value.limit,
      })),
    };
  }
}
