import assert from 'node:assert/strict';

/** Numeric budgets are advisory; absent or invalid observations are errors. */
export function evaluateFrameWorkBudget(
  budget: unknown,
  viewport: string,
  frames: readonly Record<string, number>[]
) {
  assert(
    budget && typeof budget === 'object' && 'viewport' in budget && 'maximumPerFrame' in budget
  );
  assert.equal(budget.viewport, viewport, 'Budget belongs to another viewport');
  const limits = budget.maximumPerFrame;
  assert(limits && typeof limits === 'object' && !Array.isArray(limits));
  assert(Object.keys(limits).length > 0, 'Empty work budget');
  assert(frames.length > 0, 'Missing frame observations');
  return Object.entries(limits).map(([metric, maximum]) => {
    assert(typeof maximum === 'number' && Number.isFinite(maximum) && maximum >= 0);
    let observedMaximum = 0;
    let exceededFrames = 0;
    for (const frame of frames) {
      const actual = frame[metric];
      assert(
        typeof actual === 'number' && Number.isFinite(actual) && actual >= 0,
        `Missing or invalid observation: ${metric}`
      );
      observedMaximum = Math.max(observedMaximum, actual);
      if (actual > maximum) {
        exceededFrames++;
      }
    }
    return {
      metric,
      maximum,
      observedMaximum,
      delta: observedMaximum - maximum,
      exceededFrames,
      measuredFrames: frames.length,
    };
  });
}
