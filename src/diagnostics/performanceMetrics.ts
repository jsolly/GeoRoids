import { logger } from '../utils/Logger';

const SAMPLE_LIMIT = 4096;
type Metric =
  | 'frameIntervalMs'
  | 'updateMs'
  | 'renderMs'
  | 'frameCpuMs'
  | 'messageMs'
  | 'keyframeMessageMs'
  | 'deltaMessageMs'
  | 'hiddenDurationMs'
  | 'parseMs'
  | 'keyframeDecodeMs'
  | 'deltaDecodeMs'
  | 'applyMs'
  | 'inputToRenderMs'
  | 'joinMs'
  | 'recoveryMs';
type Phase = 'menu' | 'play' | 'respawn' | 'hidden';
type Samples = { values: number[]; count: number; sum: number; max: number; over33Ms: number };

/** Bounded opt-in observations; retained values are a prefix, never an implied full run. */
export class ClientPerformanceMetrics {
  private readonly series = new Map<string, Samples>();
  private readonly counters: Record<string, number> = {};
  private phase: Phase = 'menu';
  private pendingInputAt: number | undefined;
  private authoritativeStateReady = false;
  private joinStartedAt: number | undefined;
  private recoveryStartedAt: number | undefined;
  private startedAt = performance.now();
  private nextExportAt = this.startedAt + 15_000;
  public serverReleaseId: string | undefined;

  constructor(public readonly enabled: boolean) {}

  setPhase(phase: Phase): void {
    this.phase = phase;
    if (phase !== 'play' && phase !== 'respawn') {
      this.pendingInputAt = undefined;
    }
  }

  record(metric: Metric, milliseconds: number): void {
    if (!this.enabled) {
      return;
    }
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      this.count('invalidSamples');
      return;
    }
    const key = `${this.phase}.${metric}`;
    let samples = this.series.get(key);
    if (!samples) {
      samples = { values: [], count: 0, sum: 0, max: 0, over33Ms: 0 };
      this.series.set(key, samples);
    }
    samples.count++;
    samples.sum += milliseconds;
    samples.max = Math.max(samples.max, milliseconds);
    if (milliseconds > 1000 / 30) {
      samples.over33Ms++;
    }
    if (samples.values.length < SAMPLE_LIMIT) {
      samples.values.push(milliseconds);
    }
  }

  count(
    name:
      | 'joinAttempts'
      | 'joinFailures'
      | 'messageFailures'
      | 'resyncs'
      | 'disconnects'
      | 'hiddenPeriods'
      | 'frameFailures'
      | 'invalidSamples'
      | 'recoveryAttempts'
      | 'recoveryFailures'
  ): void {
    if (this.enabled) {
      this.counters[name] = (this.counters[name] ?? 0) + 1;
    }
  }

  input(now: number): void {
    if (this.enabled && (this.phase === 'play' || this.phase === 'respawn')) {
      this.pendingInputAt ??= now;
    }
  }

  rendered(now: number): void {
    if (this.authoritativeStateReady) {
      if (this.joinStartedAt !== undefined) {
        this.record('joinMs', now - this.joinStartedAt);
        this.joinStartedAt = undefined;
      }
      if (this.recoveryStartedAt !== undefined) {
        this.record('recoveryMs', now - this.recoveryStartedAt);
        this.recoveryStartedAt = undefined;
      }
      this.authoritativeStateReady = false;
    }
    if (this.pendingInputAt !== undefined) {
      this.record('inputToRenderMs', now - this.pendingInputAt);
      this.pendingInputAt = undefined;
    }
  }

  join(now: number): void {
    if (!this.enabled) {
      return;
    }
    this.count('joinAttempts');
    this.joinStartedAt = now;
    this.authoritativeStateReady = false;
  }

  recover(now: number): void {
    if (!this.enabled) {
      return;
    }
    if (this.recoveryStartedAt !== undefined) {
      return;
    }
    this.count('recoveryAttempts');
    this.pendingInputAt = undefined;
    this.recoveryStartedAt = now;
    this.authoritativeStateReady = false;
  }

  joinFailed(): void {
    if (this.joinStartedAt === undefined) {
      return;
    }
    this.count('joinFailures');
    this.joinStartedAt = undefined;
  }

  recoveryFailed(): void {
    if (this.recoveryStartedAt === undefined) {
      return;
    }
    this.count('recoveryFailures');
    this.recoveryStartedAt = undefined;
  }

  /** Clear recovery state when a session is intentionally torn down. */
  cancelRecovery(): void {
    if (!this.enabled) {
      return;
    }
    this.recoveryStartedAt = undefined;
    this.pendingInputAt = undefined;
    this.authoritativeStateReady = false;
  }

  stateApplied(): void {
    if (this.enabled) {
      this.authoritativeStateReady = true;
    }
  }

  read(reset = false) {
    const now = performance.now();
    const result = {
      schemaVersion: 1,
      clientReleaseId: import.meta.env['VITE_COMMIT_HASH'] ?? 'unknown',
      serverReleaseId: this.serverReleaseId ?? 'unknown',
      durationMs: now - this.startedAt,
      phase: this.phase,
      pendingJoin: this.joinStartedAt !== undefined,
      pendingRecovery: this.recoveryStartedAt !== undefined,
      counters: { ...this.counters },
      metrics: Object.fromEntries(
        [...this.series].map(([key, samples]) => [
          key,
          {
            ...samples,
            values: [...samples.values],
            omittedSamples: samples.count - samples.values.length,
          },
        ])
      ),
    };
    if (reset) {
      this.series.clear();
      for (const key of Object.keys(this.counters)) {
        delete this.counters[key];
      }
      this.startedAt = now;
    }
    return result;
  }

  exportIfDue(now: number): void {
    if (!this.enabled || now < this.nextExportAt) {
      return;
    }
    this.nextExportAt = now + 15_000;
    // Benchmark consumers drain raw values outside the frame callback.
    if (new URLSearchParams(window.location.search).get('performance') === 'collect') {
      return;
    }
    const report = this.read(true);
    logger.info('PERFORMANCE', 'client_interval', {
      ...report,
      metrics: Object.fromEntries(
        Object.entries(report.metrics).map(([name, samples]) => {
          const sorted = samples.values.toSorted((a, b) => a - b);
          return [
            name,
            {
              count: samples.count,
              max: samples.max,
              mean: samples.count ? samples.sum / samples.count : 0,
              p95OfRetainedSamples:
                sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
              omittedSamples: samples.omittedSamples,
              over33Ms: samples.over33Ms,
            },
          ];
        })
      ),
    });
  }
}

export const clientPerformance = new ClientPerformanceMetrics(
  typeof window !== 'undefined' &&
    ['1', 'collect'].includes(new URLSearchParams(window.location.search).get('performance') ?? '')
);

if (clientPerformance.enabled) {
  window.georoidsPerformance = clientPerformance;
  for (const event of ['pointerdown', 'pointermove', 'keydown', 'keyup']) {
    window.addEventListener(event, () => clientPerformance.input(performance.now()), {
      capture: true,
      passive: true,
    });
  }
  window.addEventListener('networkReconnecting', () => {
    if (!clientPerformance.read().pendingRecovery) {
      clientPerformance.count('disconnects');
    }
    clientPerformance.recover(performance.now());
  });
  window.addEventListener('networkPermanentlyDisconnected', () => {
    clientPerformance.joinFailed();
    clientPerformance.recoveryFailed();
  });
}
