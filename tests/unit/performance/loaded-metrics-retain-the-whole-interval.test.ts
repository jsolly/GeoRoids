import { expect, test } from 'vitest';
import { MeasuredMetricWindows } from '../../../benchmarks/measured-metric-windows';
import { ServerPerformanceMetrics } from '../../../server/performanceMetrics';

function fixture() {
  let now = 0;
  const metrics = new ServerPerformanceMetrics({
    enabled: true,
    now: () => now,
    wallNow: () => 1_700_000_000_000 + now,
    eventLoopUtilization: () => ({ active: 0, idle: 0, utilization: 0 }),
  });
  now = 10000;
  metrics.recordTickDuration(900);
  metrics.exportWindow();
  now = 30001;
  metrics.recordTickDuration(901);
  metrics.exportWindow();
  return {
    metrics,
    moveTo: (time: number) => {
      now = time;
    },
  };
}

test.each([
  { duration: 120000, windows: 9, tickSum: 45 },
  { duration: 300000, windows: 21, tickSum: 231 },
])(
  'loaded measurements retain all $windows exports over $duration ms',
  ({ duration, windows, tickSum }) => {
    const { metrics, moveTo } = fixture();
    try {
      const warmup = metrics.read().closedWindows ?? [];
      expect(warmup).toHaveLength(2);
      const warmupIds = warmup.map((row) => row.window.id);
      const capture = new MeasuredMetricWindows(metrics.read());
      let witness = 0;
      for (let time = 45000; time < 30001 + duration; time += 15000) {
        moveTo(time);
        metrics.recordTickDuration(++witness);
        metrics.exportWindow();
        capture.collect(metrics.read().closedWindows ?? []);
        capture.collect(metrics.read().closedWindows ?? []);
      }
      moveTo(30001 + duration);
      metrics.recordTickDuration(++witness);
      const final = metrics.exportWindow();
      const result = capture.finish(final, metrics.read().closedWindows ?? []);
      const nativeSuffix = metrics.read().closedWindows ?? [];
      expect(nativeSuffix).toHaveLength(8);
      expect(nativeSuffix.reduce((sum, row) => sum + row.window.durationMs, 0)).toBe(105001);
      expect(nativeSuffix.reduce((sum, row) => sum + row.counters.tickSamples, 0)).toBe(8);
      expect(result.closedWindows).toHaveLength(windows);
      expect(result.metricWindowCoverage.durationMs).toBe(duration);
      expect(result.closedWindows.reduce((sum, row) => sum + row.counters.tickSamples, 0)).toBe(
        windows
      );
      expect(
        result.closedWindows.reduce((sum, row) => sum + row.histograms.tickDurationMs.sum, 0)
      ).toBe(tickSum);
      expect(result.closedWindows.every((row) => row.window.finalized === true)).toBe(true);
      expect(result.closedWindows.some((row) => warmupIds.includes(row.window.id))).toBe(false);
      expect(result.closedWindows.at(-1)?.window.id).toBe(final.window.id);
      moveTo(30001 + duration + 15000);
      const later = metrics.exportWindow();
      expect(result.closedWindows.some((row) => row.window.id === later.window.id)).toBe(false);
      expect(() => capture.collect([later])).toThrow('already frozen');
    } finally {
      metrics.stop();
    }
  }
);

test('missing an exported window fails coverage instead of accepting the retained suffix', () => {
  const { metrics, moveTo } = fixture();
  try {
    const capture = new MeasuredMetricWindows(metrics.read());
    for (let time = 45000; time <= 150000; time += 15000) {
      moveTo(time);
      metrics.recordTickDuration(1);
      metrics.exportWindow();
    }
    moveTo(150001);
    const final = metrics.exportWindow();
    expect(() => capture.finish(final, metrics.read().closedWindows ?? [])).toThrow(
      'Incomplete measured metric coverage: missing window'
    );
  } finally {
    metrics.stop();
  }
});
