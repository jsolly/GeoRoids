import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';
import { logger } from '../setup/serverLogger';
import { SERVER_RELEASE_ID } from './release';

export const PERFORMANCE_EXPORT_INTERVAL_MS = 15_000;
export const PERFORMANCE_EVENT_LOOP_RESOLUTION_MS = 20;

export type PerformanceHistogramName =
  | 'tickDurationMs'
  | 'timerLatenessMs'
  | 'catchupTicks'
  | 'tickDebtMs'
  | 'discardedDebtMs'
  | 'broadcastDurationMs'
  | 'gcPauseMs'
  | 'eventLoopDelayMs'
  | 'rssBytes'
  | 'heapTotalBytes'
  | 'heapUsedBytes'
  | 'externalBytes'
  | 'arrayBuffersBytes'
  | 'outboundBufferedBytes'
  | 'outboundPayloadBytes';

const METRICS = [
  'tickDurationMs',
  'timerLatenessMs',
  'catchupTicks',
  'tickDebtMs',
  'discardedDebtMs',
  'broadcastDurationMs',
  'gcPauseMs',
  'eventLoopDelayMs',
  'rssBytes',
  'heapTotalBytes',
  'heapUsedBytes',
  'externalBytes',
  'arrayBuffersBytes',
  'outboundBufferedBytes',
  'outboundPayloadBytes',
] as const satisfies readonly PerformanceHistogramName[];
const BOUNDS: Record<PerformanceHistogramName, readonly number[]> = {
  tickDurationMs: [0.25, 0.5, 1, 2, 4, 8, 16.667, 33.333, 50, 100, 250, 500, 1000, 5000],
  timerLatenessMs: [0.25, 0.5, 1, 2, 4, 8, 16.667, 33.333, 50, 100, 250, 500, 1000, 5000],
  catchupTicks: [0, 1, 2, 4, 8, 16, 30, 60],
  tickDebtMs: [0, 1, 4, 8, 16.667, 33.333, 50, 100, 250, 500, 1000],
  discardedDebtMs: [0, 1, 4, 8, 16.667, 33.333, 50, 100, 250, 500, 1000, 5000],
  broadcastDurationMs: [0.25, 0.5, 1, 2, 4, 8, 16.667, 33.333, 50, 100, 250, 500, 1000, 5000],
  gcPauseMs: [0.25, 0.5, 1, 2, 4, 8, 16.667, 33.333, 50, 100, 250, 500, 1000, 5000],
  eventLoopDelayMs: [0.25, 0.5, 1, 2, 4, 8, 16.667, 33.333, 50, 100, 250, 500, 1000, 5000],
  rssBytes: [1_048_576, 4_194_304, 16_777_216, 67_108_864, 268_435_456, 1_073_741_824],
  heapTotalBytes: [1_048_576, 4_194_304, 16_777_216, 67_108_864, 268_435_456, 1_073_741_824],
  heapUsedBytes: [1_048_576, 4_194_304, 16_777_216, 67_108_864, 268_435_456, 1_073_741_824],
  externalBytes: [1_048_576, 4_194_304, 16_777_216, 67_108_864, 268_435_456, 1_073_741_824],
  arrayBuffersBytes: [1_048_576, 4_194_304, 16_777_216, 67_108_864, 268_435_456, 1_073_741_824],
  outboundBufferedBytes: [0, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304],
  outboundPayloadBytes: [0, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304],
};

export interface PerformanceHistogramBucket {
  upperBound: number;
  count: number;
}
export interface PerformanceHistogramSummary {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  buckets: readonly PerformanceHistogramBucket[];
  overflow: number;
}
export type OutboundKind = 'snapshot' | 'event' | 'control';
export type OutboundOutcome =
  | 'accepted'
  | 'failed'
  | 'pressure-skipped'
  | 'pressure-closed'
  | 'not-open';
export interface OutboundKindCounters {
  attempted: number;
  accepted: number;
  failed: number;
  pressureSkipped: number;
  pressureClosed: number;
  notOpen: number;
  acceptedBytes: number;
}
export interface OutboundCounters {
  attempted: number;
  accepted: number;
  failed: number;
  pressureSkipped: number;
  pressureClosed: number;
  notOpen: number;
  acceptedBytes: number;
  byKind: Record<OutboundKind, OutboundKindCounters>;
}
export interface PerformanceCounters {
  scheduledCallbacks: number;
  tickSamples: number;
  invalidMetricSamples: number;
  gcEvents: number;
  catchupCallbacks: number;
  catchupTicks: number;
  discardedDebtMs: number;
  backwardClockJumps: number;
  invalidClockSamples: number;
  broadcastSamples: number;
  outbound: OutboundCounters;
}
export interface EventLoopDelaySummary {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  exceeds: number;
}
export interface EventLoopSummary {
  delay: EventLoopDelaySummary;
  utilization: number;
  activeMs: number;
  idleMs: number;
}
export interface MemorySample {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}
export interface ServerPerformanceSummary {
  version: 1;
  releaseId: string;
  window: { startedAt: string; endedAt: string; durationMs: number };
  counters: PerformanceCounters;
  histograms: Record<PerformanceHistogramName, PerformanceHistogramSummary>;
  eventLoop: EventLoopSummary;
  memory: { current: MemorySample };
  outbound: { counters: OutboundCounters };
}
export interface EventLoopDelaySampler {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly exceeds: number;
  percentile(percentile: number): number;
  reset(): void;
  enable(): boolean;
  disable(): boolean;
}
export interface GcPerformanceObserver {
  observe(): void;
  disconnect(): void;
}
export type GcPerformanceObserverFactory = (
  onDuration: (durationMs: number) => void
) => GcPerformanceObserver;
type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;
type EventLoopUtilizationReader = (previous?: EventLoopUtilization) => EventLoopUtilization;
export interface ServerPerformanceMetricsOptions {
  enabled?: boolean;
  autoStart?: boolean;
  now?: () => number;
  wallNow?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  eventLoopDelay?: EventLoopDelaySampler;
  eventLoopUtilization?: EventLoopUtilizationReader;
  gcObserverFactory?: GcPerformanceObserverFactory;
}

const defaultGcObserverFactory: GcPerformanceObserverFactory = (onDuration) => {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      onDuration(entry.duration);
    }
  });
  return {
    observe: () => observer.observe({ entryTypes: ['gc'] }),
    disconnect: () => observer.disconnect(),
  };
};

class BoundedHistogram {
  private readonly counts: number[];
  private count = 0;
  private sum = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;
  private overflow = 0;
  constructor(private readonly bounds: readonly number[]) {
    this.counts = bounds.map(() => 0);
  }
  record(value: number): boolean {
    if (!Number.isFinite(value) || value < 0) {
      return false;
    }
    this.count++;
    this.sum += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    const index = this.bounds.findIndex((bound) => value <= bound);
    if (index < 0) {
      this.overflow++;
    } else {
      this.counts[index] = (this.counts[index] ?? 0) + 1;
    }
    return true;
  }
  summary(): PerformanceHistogramSummary {
    const percentile = (fraction: number): number | null => {
      if (!this.count) {
        return null;
      }
      const target = Math.max(1, Math.ceil(this.count * fraction));
      let seen = 0;
      for (let i = 0; i < this.bounds.length; i++) {
        seen += this.counts[i] ?? 0;
        if (seen >= target) {
          return this.bounds[i] ?? this.max;
        }
      }
      return this.max;
    };
    return {
      count: this.count,
      sum: this.sum,
      min: this.count ? this.min : null,
      max: this.count ? this.max : null,
      mean: this.count ? this.sum / this.count : null,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      buckets: this.bounds.map((upperBound, i) => ({ upperBound, count: this.counts[i] ?? 0 })),
      overflow: this.overflow,
    };
  }
  reset(): void {
    this.counts.fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.overflow = 0;
  }
}
type Histograms = Record<PerformanceHistogramName, BoundedHistogram>;
function histograms(): Histograms {
  return Object.fromEntries(
    METRICS.map((name) => [name, new BoundedHistogram(BOUNDS[name])])
  ) as Histograms;
}
const zeroKind = (): OutboundKindCounters => ({
  attempted: 0,
  accepted: 0,
  failed: 0,
  pressureSkipped: 0,
  pressureClosed: 0,
  notOpen: 0,
  acceptedBytes: 0,
});
const zeroOutbound = (): OutboundCounters => ({
  attempted: 0,
  accepted: 0,
  failed: 0,
  pressureSkipped: 0,
  pressureClosed: 0,
  notOpen: 0,
  acceptedBytes: 0,
  byKind: { snapshot: zeroKind(), event: zeroKind(), control: zeroKind() },
});
const zeroCounters = (): PerformanceCounters => ({
  scheduledCallbacks: 0,
  tickSamples: 0,
  invalidMetricSamples: 0,
  gcEvents: 0,
  catchupCallbacks: 0,
  catchupTicks: 0,
  discardedDebtMs: 0,
  backwardClockJumps: 0,
  invalidClockSamples: 0,
  broadcastSamples: 0,
  outbound: zeroOutbound(),
});
const safe = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);
const memory = (read: () => NodeJS.MemoryUsage): MemorySample => {
  const m = read();
  return {
    rssBytes: safe(m.rss),
    heapTotalBytes: safe(m.heapTotal),
    heapUsedBytes: safe(m.heapUsed),
    externalBytes: safe(m.external),
    arrayBuffersBytes: safe(m.arrayBuffers),
  };
};
const millis = (value: number): number | null =>
  Number.isFinite(value) && value >= 0 ? value / 1e6 : null;
const cloneOutbound = (value: OutboundCounters): OutboundCounters => ({
  ...value,
  byKind: {
    snapshot: { ...value.byKind.snapshot },
    event: { ...value.byKind.event },
    control: { ...value.byKind.control },
  },
});
const EMPTY_TIME = new Date(0).toISOString();
const OUTCOME_COUNTER: Record<
  OutboundOutcome,
  keyof Omit<OutboundKindCounters, 'attempted' | 'acceptedBytes'>
> = {
  accepted: 'accepted',
  failed: 'failed',
  'pressure-skipped': 'pressureSkipped',
  'pressure-closed': 'pressureClosed',
  'not-open': 'notOpen',
};

export class ServerPerformanceMetrics {
  private readonly enabledFlag: boolean;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly delayMonitor: EventLoopDelaySampler | undefined;
  private readonly eventLoopUtilization: EventLoopUtilizationReader;
  private readonly gcObserverFactory: GcPerformanceObserverFactory | undefined;
  private readonly hist = histograms();
  private counters = zeroCounters();
  private utilizationBaseline: EventLoopUtilization | undefined;
  private startedAt = 0;
  private startedWall = 0;
  private exportTimer: NodeJS.Timeout | undefined;
  private gcObserver: GcPerformanceObserver | undefined;
  constructor(options: ServerPerformanceMetricsOptions = {}) {
    this.enabledFlag = options.enabled ?? serverPerformanceMetricsEnabled();
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.delayMonitor = this.enabledFlag
      ? (options.eventLoopDelay ??
        monitorEventLoopDelay({ resolution: PERFORMANCE_EVENT_LOOP_RESOLUTION_MS }))
      : undefined;
    this.eventLoopUtilization =
      options.eventLoopUtilization ?? ((previous) => performance.eventLoopUtilization(previous));
    this.gcObserverFactory = this.enabledFlag
      ? (options.gcObserverFactory ?? defaultGcObserverFactory)
      : undefined;
    if (this.enabledFlag) {
      this.utilizationBaseline = this.eventLoopUtilization();
      this.startedAt = this.now();
      this.startedWall = this.wallNow();
      if (options.autoStart) {
        this.start();
      }
    }
  }
  get enabled(): boolean {
    return this.enabledFlag;
  }
  start(): void {
    if (!this.enabledFlag || this.exportTimer) {
      return;
    }
    this.delayMonitor?.enable();
    this.gcObserver = this.gcObserverFactory?.((durationMs) => this.recordGcPause(durationMs));
    this.gcObserver?.observe();
    this.exportTimer = setInterval(() => this.exportWindow(), PERFORMANCE_EXPORT_INTERVAL_MS);
    this.exportTimer.unref();
  }
  stop(): void {
    if (!this.enabledFlag) {
      return;
    }
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
    }
    this.exportTimer = undefined;
    this.delayMonitor?.disable();
    this.gcObserver?.disconnect();
    this.gcObserver = undefined;
    this.reset();
  }
  recordTickDuration(value: number): void {
    if (this.enabledFlag) {
      if (this.hist.tickDurationMs.record(value)) {
        this.counters.tickSamples++;
      } else {
        this.counters.invalidMetricSamples++;
      }
    }
  }
  recordClock(s: {
    timerLatenessMs: number;
    catchupTicks: number;
    debtMs: number;
    discardedDebtMs: number;
    backwards?: boolean;
    invalid?: boolean;
  }): void {
    if (!this.enabledFlag) {
      return;
    }
    this.counters.scheduledCallbacks++;
    const latenessValid = this.hist.timerLatenessMs.record(s.timerLatenessMs);
    const catchupValid = this.hist.catchupTicks.record(s.catchupTicks);
    const debtValid = this.hist.tickDebtMs.record(s.debtMs);
    const discardedValid = this.hist.discardedDebtMs.record(s.discardedDebtMs);
    if (!latenessValid) {
      this.counters.invalidMetricSamples++;
    }
    if (!catchupValid) {
      this.counters.invalidMetricSamples++;
    }
    if (!debtValid) {
      this.counters.invalidMetricSamples++;
    }
    if (!discardedValid) {
      this.counters.invalidMetricSamples++;
    }
    if (catchupValid) {
      this.counters.catchupTicks += Math.floor(s.catchupTicks);
    }
    if (catchupValid && s.catchupTicks > 1) {
      this.counters.catchupCallbacks++;
    }
    if (discardedValid) {
      this.counters.discardedDebtMs += s.discardedDebtMs;
    }
    if (s.backwards) {
      this.counters.backwardClockJumps++;
    }
    if (s.invalid) {
      this.counters.invalidClockSamples++;
    }
  }
  recordBroadcast(value: number): void {
    if (this.enabledFlag) {
      if (this.hist.broadcastDurationMs.record(value)) {
        this.counters.broadcastSamples++;
      } else {
        this.counters.invalidMetricSamples++;
      }
    }
  }
  private recordGcPause(value: number): void {
    if (!this.enabledFlag) {
      return;
    }
    if (this.hist.gcPauseMs.record(value)) {
      this.counters.gcEvents++;
    } else {
      this.counters.invalidMetricSamples++;
    }
  }
  recordOutbound(s: {
    kind: OutboundKind;
    outcome: OutboundOutcome;
    payloadBytes?: number;
    bufferedBytes?: number;
  }): void {
    if (!this.enabledFlag) {
      return;
    }
    const payloadInput = s.payloadBytes ?? 0;
    const bufferedInput = s.bufferedBytes ?? 0;
    const payloadValid = this.hist.outboundPayloadBytes.record(payloadInput);
    const bufferedValid = this.hist.outboundBufferedBytes.record(bufferedInput);
    this.counters.invalidMetricSamples += Number(!payloadValid) + Number(!bufferedValid);
    const payload = payloadValid ? payloadInput : 0;
    const all = this.counters.outbound;
    const kind = all.byKind[s.kind];
    const field = OUTCOME_COUNTER[s.outcome];
    all.attempted++;
    kind.attempted++;
    all[field]++;
    kind[field]++;
    if (field === 'accepted') {
      all.acceptedBytes += payload;
      kind.acceptedBytes += payload;
    }
  }
  recordMemorySample(sample?: MemorySample): void {
    if (!this.enabledFlag) {
      return;
    }
    const m = sample ?? memory(this.memoryUsage);
    if (!this.hist.rssBytes.record(m.rssBytes)) {
      this.counters.invalidMetricSamples++;
    }
    if (!this.hist.heapTotalBytes.record(m.heapTotalBytes)) {
      this.counters.invalidMetricSamples++;
    }
    if (!this.hist.heapUsedBytes.record(m.heapUsedBytes)) {
      this.counters.invalidMetricSamples++;
    }
    if (!this.hist.externalBytes.record(m.externalBytes)) {
      this.counters.invalidMetricSamples++;
    }
    if (!this.hist.arrayBuffersBytes.record(m.arrayBuffersBytes)) {
      this.counters.invalidMetricSamples++;
    }
  }
  read(): ServerPerformanceSummary {
    return this.enabledFlag ? this.summary(memory(this.memoryUsage)) : this.emptySummary();
  }
  drain(): ServerPerformanceSummary {
    if (!this.enabledFlag) {
      return this.emptySummary();
    }
    const m = memory(this.memoryUsage);
    this.recordMemorySample(m);
    const result = this.summary(m);
    this.reset();
    return result;
  }
  exportWindow(): ServerPerformanceSummary {
    const result = this.drain();
    if (this.enabledFlag) {
      logger.info('PERF', 'server_performance_window', result);
    }
    return result;
  }
  private summary(m: MemorySample): ServerPerformanceSummary {
    const ended = this.now();
    const endedWall = this.wallNow();
    const hs = Object.fromEntries(
      METRICS.map((name) => [name, this.hist[name].summary()])
    ) as Record<PerformanceHistogramName, PerformanceHistogramSummary>;
    const eventLoop = this.eventLoop();
    const delay = eventLoop.delay;
    hs.eventLoopDelayMs = {
      count: delay.count,
      sum: delay.meanMs === null ? 0 : delay.meanMs * delay.count,
      min: delay.minMs,
      max: delay.maxMs,
      mean: delay.meanMs,
      p50: delay.p50Ms,
      p95: delay.p95Ms,
      p99: delay.p99Ms,
      buckets: [],
      overflow: delay.exceeds,
    };
    return {
      version: 1,
      releaseId: SERVER_RELEASE_ID,
      window: {
        startedAt: new Date(this.startedWall).toISOString(),
        endedAt: new Date(endedWall).toISOString(),
        durationMs: Math.max(0, ended - this.startedAt),
      },
      counters: { ...this.counters, outbound: cloneOutbound(this.counters.outbound) },
      histograms: hs,
      eventLoop,
      memory: { current: m },
      outbound: { counters: cloneOutbound(this.counters.outbound) },
    };
  }
  private emptySummary(): ServerPerformanceSummary {
    const hs = Object.fromEntries(
      METRICS.map((name) => [name, this.hist[name].summary()])
    ) as Record<PerformanceHistogramName, PerformanceHistogramSummary>;
    const counters = zeroCounters();
    return {
      version: 1,
      releaseId: SERVER_RELEASE_ID,
      window: { startedAt: EMPTY_TIME, endedAt: EMPTY_TIME, durationMs: 0 },
      counters,
      histograms: hs,
      eventLoop: {
        delay: {
          count: 0,
          minMs: null,
          maxMs: null,
          meanMs: null,
          p50Ms: null,
          p95Ms: null,
          p99Ms: null,
          exceeds: 0,
        },
        utilization: 0,
        activeMs: 0,
        idleMs: 0,
      },
      memory: {
        current: {
          rssBytes: 0,
          heapTotalBytes: 0,
          heapUsedBytes: 0,
          externalBytes: 0,
          arrayBuffersBytes: 0,
        },
      },
      outbound: { counters: zeroOutbound() },
    };
  }
  private eventLoop(): EventLoopSummary {
    if (!this.delayMonitor || !this.utilizationBaseline) {
      return {
        delay: {
          count: 0,
          minMs: null,
          maxMs: null,
          meanMs: null,
          p50Ms: null,
          p95Ms: null,
          p99Ms: null,
          exceeds: 0,
        },
        utilization: 0,
        activeMs: 0,
        idleMs: 0,
      };
    }
    const d = this.delayMonitor;
    const delay: EventLoopDelaySummary = {
      count: d.count,
      minMs: d.count ? millis(d.min) : null,
      maxMs: d.count ? millis(d.max) : null,
      meanMs: d.count ? millis(d.mean) : null,
      p50Ms: d.count ? millis(d.percentile(50)) : null,
      p95Ms: d.count ? millis(d.percentile(95)) : null,
      p99Ms: d.count ? millis(d.percentile(99)) : null,
      exceeds: d.exceeds,
    };
    const u = this.eventLoopUtilization(this.utilizationBaseline);
    return {
      delay,
      utilization: Math.min(1, Math.max(0, safe(u.utilization))),
      activeMs: safe(u.active),
      idleMs: safe(u.idle),
    };
  }
  private reset(): void {
    for (const h of Object.values(this.hist)) {
      h.reset();
    }
    this.delayMonitor?.reset();
    this.utilizationBaseline = this.eventLoopUtilization();
    this.counters = zeroCounters();
    this.startedAt = this.now();
    this.startedWall = this.wallNow();
  }
}

export const serverPerformanceMetrics = new ServerPerformanceMetrics({ autoStart: false });
let serverPerformanceMetricsOwners = 0;

/**
 * The singleton is a process aggregate shared by every server instance in
 * this process. Keep its exporter alive until the last instance releases it.
 */
export function acquireServerPerformanceMetrics(): void {
  serverPerformanceMetricsOwners++;
  if (serverPerformanceMetricsOwners === 1) {
    serverPerformanceMetrics.start();
  }
}

export function releaseServerPerformanceMetrics(): void {
  if (serverPerformanceMetricsOwners === 0) {
    return;
  }
  serverPerformanceMetricsOwners--;
  if (serverPerformanceMetricsOwners === 0) {
    serverPerformanceMetrics.stop();
  }
}

export function serverPerformanceMetricsEnabled(env?: {
  readonly GEOROIDS_PERFORMANCE?: string;
}): boolean {
  return (env?.GEOROIDS_PERFORMANCE ?? process.env['GEOROIDS_PERFORMANCE']) === '1';
}
