/* @vitest-environment node */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  acquireServerPerformanceMetrics,
  type EventLoopDelaySampler,
  type GcPerformanceObserver,
  type GcPerformanceObserverFactory,
  PERFORMANCE_EXPORT_INTERVAL_MS,
  releaseServerPerformanceMetrics,
  ServerPerformanceMetrics,
  serverPerformanceMetrics,
} from '../../../server/performanceMetrics';
import { logger } from '../../../setup/serverLogger';

class FakeEventLoopDelay implements EventLoopDelaySampler {
  count = 0;
  min = 20_000_000;
  max = 40_000_000;
  mean = 30_000_000;
  exceeds = 0;
  enabled = false;

  percentile(percentile: number): number {
    return percentile >= 95 ? this.max : this.mean;
  }

  reset(): void {
    this.count = 0;
    this.exceeds = 0;
  }

  enable(): boolean {
    const changed = !this.enabled;
    this.enabled = true;
    return changed;
  }

  disable(): boolean {
    const changed = this.enabled;
    this.enabled = false;
    return changed;
  }
}

class FakeGcObserver implements GcPerformanceObserver {
  observed = false;
  disconnected = false;

  constructor(private readonly onDuration: (durationMs: number) => void) {}

  observe(): void {
    this.observed = true;
    this.disconnected = false;
  }

  disconnect(): void {
    this.observed = false;
    this.disconnected = true;
  }

  emit(...durations: number[]): void {
    if (!this.observed || this.disconnected) {
      return;
    }
    for (const duration of durations) {
      this.onDuration(duration);
    }
  }
}

function memorySample(): NodeJS.MemoryUsage {
  return {
    rss: 32 * 1024 * 1024,
    heapTotal: 16 * 1024 * 1024,
    heapUsed: 8 * 1024 * 1024,
    external: 2 * 1024 * 1024,
    arrayBuffers: 512 * 1024,
  };
}

function metrics(options: { autoStart?: boolean; delay?: FakeEventLoopDelay } = {}) {
  let monotonic = 100;
  let wall = 1_700_000_000_000;
  const delay = options.delay ?? new FakeEventLoopDelay();
  const gcObservers: FakeGcObserver[] = [];
  const instance = new ServerPerformanceMetrics({
    enabled: true,
    autoStart: options.autoStart ?? false,
    now: () => monotonic,
    wallNow: () => wall,
    memoryUsage: memorySample,
    eventLoopDelay: delay,
    eventLoopUtilization: () => ({ active: 8, idle: 92, utilization: 0.08 }),
    gcObserverFactory: (onDuration) => {
      const observer = new FakeGcObserver(onDuration);
      gcObservers.push(observer);
      return observer;
    },
  });
  return {
    instance,
    delay,
    gcObservers,
    advance: (monotonicMs: number, wallMs = wall + monotonicMs) => {
      monotonic = monotonicMs;
      wall = wallMs;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded server performance metrics', () => {
  test('aggregates fixed histograms and bounded outbound counters', () => {
    const { instance } = metrics();
    instance.recordTickDuration(2);
    instance.recordTickDuration(10_000);
    instance.recordClock({
      timerLatenessMs: 100,
      catchupTicks: 60,
      debtMs: 1000,
      discardedDebtMs: 4000,
    });
    instance.recordBroadcast(4);
    instance.recordOutbound({
      kind: 'event',
      outcome: 'pressure-closed',
      payloadBytes: 2048,
      bufferedBytes: 300_000,
    });
    instance.recordOutbound({
      kind: 'snapshot',
      outcome: 'accepted',
      payloadBytes: 4096,
      bufferedBytes: 0,
    });

    const summary = instance.read();
    expect(summary.releaseId).toEqual(expect.any(String));
    expect(summary.histograms.tickDurationMs.count).toBe(2);
    expect(summary.histograms.tickDurationMs.overflow).toBe(1);
    expect(summary.histograms.timerLatenessMs.p50).toBe(100);
    expect(summary.histograms.catchupTicks.p50).toBe(60);
    expect(summary.histograms.discardedDebtMs.p50).toBe(5000);
    expect(summary.histograms.tickDurationMs.buckets.length).toBeLessThan(20);
    expect(summary.counters.outbound.pressureClosed).toBe(1);
    expect(summary.counters.outbound.byKind.event.pressureClosed).toBe(1);
    expect(summary.counters.outbound.byKind.snapshot.acceptedBytes).toBe(4096);
  });

  test('drain includes one memory sample and clears the next retrieval window', () => {
    const { instance } = metrics();
    instance.recordTickDuration(1);
    const drained = instance.drain();

    expect(drained.counters.tickSamples).toBe(1);
    expect(drained.memory.current.rssBytes).toBe(32 * 1024 * 1024);
    expect(drained.histograms.rssBytes.count).toBe(1);
    expect(instance.read().counters.tickSamples).toBe(0);
    expect(instance.read().histograms.rssBytes.count).toBe(0);
  });

  test('the exporter emits one release-correlated aggregate every 15 seconds', () => {
    vi.useFakeTimers();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { instance, gcObservers } = metrics();
    instance.start();
    gcObservers[0]?.emit(3);
    vi.advanceTimersByTime(PERFORMANCE_EXPORT_INTERVAL_MS);
    instance.stop();

    expect(info).toHaveBeenCalledWith(
      'PERF',
      'server_performance_window',
      expect.objectContaining({
        version: 1,
        releaseId: expect.any(String),
        counters: expect.objectContaining({ gcEvents: 1 }),
        histograms: expect.objectContaining({ gcPauseMs: expect.objectContaining({ count: 1 }) }),
      })
    );
  });

  test('GC observations are bounded per window and disconnected between owners', () => {
    const { instance, gcObservers } = metrics();
    instance.start();
    const first = gcObservers[0];
    expect(first?.observed).toBe(true);

    first?.emit(1, 10_000);
    expect(instance.read()).toMatchObject({
      counters: { gcEvents: 2 },
      histograms: { gcPauseMs: { count: 2, overflow: 1 } },
    });

    instance.stop();
    expect(first?.disconnected).toBe(true);
    expect(instance.read().counters.gcEvents).toBe(0);
    first?.emit(2);
    expect(instance.read().counters.gcEvents).toBe(0);

    instance.start();
    expect(gcObservers).toHaveLength(2);
    expect(gcObservers[1]?.observed).toBe(true);
    instance.stop();
  });

  test('the shared singleton is the load benchmark retrieval API', () => {
    expect(serverPerformanceMetrics).toBeDefined();
  });

  test('shared exporter stops only after the last server instance releases it', () => {
    const start = vi.spyOn(serverPerformanceMetrics, 'start');
    const stop = vi.spyOn(serverPerformanceMetrics, 'stop');

    acquireServerPerformanceMetrics();
    acquireServerPerformanceMetrics();
    releaseServerPerformanceMetrics();
    expect(stop).not.toHaveBeenCalled();

    releaseServerPerformanceMetrics();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  test('failed outbound completion is one terminal counter outcome', () => {
    const { instance } = metrics();
    instance.recordOutbound({
      kind: 'snapshot',
      outcome: 'failed',
      payloadBytes: 128,
      bufferedBytes: 64,
    });

    expect(instance.read().counters.outbound).toMatchObject({
      attempted: 1,
      accepted: 0,
      failed: 1,
      acceptedBytes: 0,
      byKind: {
        snapshot: { attempted: 1, accepted: 0, failed: 1, acceptedBytes: 0 },
      },
    });
  });

  test('invalid metric values are counted and excluded from valid samples', () => {
    const { instance } = metrics();
    instance.recordTickDuration(-1);
    instance.recordClock({
      timerLatenessMs: Number.NaN,
      catchupTicks: Number.POSITIVE_INFINITY,
      debtMs: -1,
      discardedDebtMs: 0,
    });
    instance.recordBroadcast(-1);
    instance.recordOutbound({
      kind: 'event',
      outcome: 'accepted',
      payloadBytes: -1,
      bufferedBytes: Number.NaN,
    });

    const summary = instance.read();
    expect(summary.counters.invalidMetricSamples).toBe(7);
    expect(summary.counters.tickSamples).toBe(0);
    expect(summary.counters.broadcastSamples).toBe(0);
    expect(summary.histograms.outboundPayloadBytes.count).toBe(0);
    expect(summary.counters.outbound.acceptedBytes).toBe(0);
  });

  test('disabled metrics do not sample memory or create an exporter', () => {
    const memoryUsage = vi.fn(memorySample);
    const delay = new FakeEventLoopDelay();
    const gcObserverFactory = vi.fn<GcPerformanceObserverFactory>();
    const instance = new ServerPerformanceMetrics({
      enabled: false,
      autoStart: true,
      memoryUsage,
      eventLoopDelay: delay,
      eventLoopUtilization: () => {
        throw new Error('disabled metrics must not read event-loop utilization');
      },
      gcObserverFactory,
    });

    instance.recordMemorySample();
    instance.recordTickDuration(1);
    instance.start();

    expect(instance.enabled).toBe(false);
    expect(delay.enabled).toBe(false);
    expect(gcObserverFactory).not.toHaveBeenCalled();
    expect(memoryUsage).not.toHaveBeenCalled();
    expect(instance.read().counters.tickSamples).toBe(0);
  });
});

test('health polls expose the same finalized window without counting its observations twice', () => {
  const metrics = new ServerPerformanceMetrics({ enabled: true, autoStart: false });
  metrics.recordTransportAcceptance(4);
  const finalized = metrics.drain();
  const first = metrics.read();
  const second = metrics.read();
  expect(finalized.window.finalized).toBe(true);
  expect(first.window.finalized).toBe(false);
  expect(first.window.id).not.toBe(finalized.window.id);
  expect(first.closedWindows?.[0]?.window.id).toBe(second.closedWindows?.[0]?.window.id);
  expect(finalized.histograms.transportAcceptanceMs.count).toBe(1);
  expect(second.histograms.transportAcceptanceMs.count).toBe(0);
  metrics.stop();
  expect(metrics.read().closedWindows).toEqual([]);
});
