import { describe, expect, it } from 'vitest';
import { evaluateFrameWorkBudget } from '../../../benchmarks/frame-work-budget';

describe('performance budgets inform development without blocking it', () => {
  const budget = { viewport: 'touch-portrait', maximumPerFrame: { reads: 1000 } };
  it('retains an exceeded budget and its magnitude without throwing', () => {
    expect(
      evaluateFrameWorkBudget(budget, 'touch-portrait', [{ reads: 1388 }, { reads: 900 }])
    ).toEqual([
      {
        metric: 'reads',
        maximum: 1000,
        observedMaximum: 1388,
        delta: 388,
        exceededFrames: 1,
        measuredFrames: 2,
      },
    ]);
  });
  it('retains headroom below the budget', () => {
    expect(evaluateFrameWorkBudget(budget, 'touch-portrait', [{ reads: 900 }])[0]).toMatchObject({
      delta: -100,
      exceededFrames: 0,
    });
  });
  it('rejects missing and invalid measurements instead of calling them passing', () => {
    for (const frames of [[], [{}], [{ reads: Number.NaN }], [{ reads: -1 }]]) {
      expect(() => evaluateFrameWorkBudget(budget, 'touch-portrait', frames)).toThrow();
    }
    expect(() => evaluateFrameWorkBudget(budget, 'desktop', [{ reads: 1 }])).toThrow();
    expect(() =>
      evaluateFrameWorkBudget({ ...budget, maximumPerFrame: { reads: '1000' } }, 'touch-portrait', [
        { reads: 1 },
      ])
    ).toThrow();
  });
});
