import { describe, expect, it, vi } from 'vitest';
import { PerformanceBudget } from '../../../benchmarks/performance-budget';

describe('network performance observations are reported without notifications', () => {
  it('retains exceeded thresholds and worse samples without emitting warnings', () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const budget = new PerformanceBudget();
      budget.observe('gapMs', 200, 250);
      budget.observe('gapMs', 300, 250);
      budget.observe('gapMs', 900, 250);
      budget.observe('stateHz', 10, 27, 'minimum');
      expect(output).not.toHaveBeenCalled();
      expect(budget.report()).toEqual({
        policy: 'report-only',
        observations: [
          {
            metric: 'gapMs',
            direction: 'maximum',
            limit: 250,
            worst: 900,
            samples: 3,
            exceededSamples: 2,
            delta: 650,
          },
          {
            metric: 'stateHz',
            direction: 'minimum',
            limit: 27,
            worst: 10,
            samples: 1,
            exceededSamples: 1,
            delta: -17,
          },
        ],
      });
    } finally {
      output.mockRestore();
    }
  });
  it('still rejects invalid measurements or limits', () => {
    const budget = new PerformanceBudget();
    for (const value of [NaN, Infinity, -1]) {
      expect(() => budget.observe('gap', value, 250)).toThrow();
      expect(() => budget.observe('gap', 100, value)).toThrow();
    }
  });
});
