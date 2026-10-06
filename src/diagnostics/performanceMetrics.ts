import type { GpuFrameStats } from '../rendering/gpuRearRenderer';
import { logger } from '../utils/Logger';
import { installPhoneCollector } from './phoneCollector';

const SAMPLE_LIMIT = 4096;
export const APPLIED_SNAPSHOT_SAMPLE_LIMIT = SAMPLE_LIMIT;
const encoder = new TextEncoder();
type Metric =
  | 'rttMs'
  | 'messageGapMs'
  | 'collectionGapMs'
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
type AppliedSnapshot = {
  appliedAt: number;
  ownerId: string | undefined;
  session: number;
  sequence: number;
  kind: 'keyframe' | 'delta';
  gameTime: number;
  serverTime: number | undefined;
};

/** Bounded opt-in observations; retained values are a prefix, never an implied full run. */
export class ClientPerformanceMetrics {
  private readonly series = new Map<string, Samples>();
  private readonly counters: Record<string, number> = {};
  private lastSnapshot:
    | {
        sequence: number;
        kind: 'keyframe' | 'delta';
        gameTime: number;
        serverTime: number | undefined;
      }
    | undefined;
  private lastKeyframeSequence = 0;
  private snapshotSession = 0;
  private appliedSnapshotCount = 0;
  private readonly appliedSnapshots: AppliedSnapshot[] = [];

  /** Snapshot sequence numbers belong to one transport/join session. */
  resetSnapshotWitness(): void {
    this.lastSnapshot = undefined;
    this.lastKeyframeSequence = 0;
    this.snapshotSession++;
  }

  snapshotApplied(snapshot: {
    ownerId: string | undefined;
    sequence: number;
    kind: 'keyframe' | 'delta';
    gameTime: number;
    serverTime: number | undefined;
  }): void {
    this.lastSnapshot = {
      sequence: snapshot.sequence,
      kind: snapshot.kind,
      gameTime: snapshot.gameTime,
      serverTime: snapshot.serverTime,
    };
    if (this.enabled) {
      this.appliedSnapshotCount++;
      if (this.appliedSnapshots.length < APPLIED_SNAPSHOT_SAMPLE_LIMIT) {
        this.appliedSnapshots.push({
          ...snapshot,
          session: this.snapshotSession,
          appliedAt: performance.now(),
        });
      }
    }
    if (snapshot.kind === 'keyframe') {
      this.lastKeyframeSequence = snapshot.sequence;
    }
  }

  private phase: Phase = 'menu';
  private phaseStartedAt = performance.now();
  private drainOwner: string | undefined;

  claimDrain(owner: string): void {
    if (this.drainOwner !== undefined && this.drainOwner !== owner) {
      throw new Error(`Performance drain owned by ${this.drainOwner}`);
    }
    this.drainOwner = owner;
  }

  releaseDrain(owner: string): void {
    if (this.drainOwner === owner) {
      this.drainOwner = undefined;
    }
  }
  private readonly phaseDurations: Record<Phase, number> = {
    menu: 0,
    play: 0,
    respawn: 0,
    hidden: 0,
  };
  private readonly messageBytes: Record<string, number> = {};
  private readonly messageCounts: Record<string, number> = {};
  private lastMessageAt: number | undefined;
  private probeSequence = 0;
  private readonly pendingProbes = new Map<number, number>();
  private readonly completedProbes = new Set<number>();
  private graphicsSettings: Record<string, string | number | boolean> = {};
  private rendererRequested: 'canvas' | 'webgl2' = 'canvas';
  private readonly rendererFrames = { canvas: 0, webgl2: 0 };
  private rendererObserver:
    | (() => { backend: 'canvas' | 'webgl2'; gpuStats: GpuFrameStats | null })
    | null = null;

  setRendererObservation(
    requested: 'canvas' | 'webgl2',
    observe: (() => { backend: 'canvas' | 'webgl2'; gpuStats: GpuFrameStats | null }) | null
  ): void {
    this.rendererRequested = requested;
    this.rendererObserver = observe;
  }

  /** Called after the frame's CPU timing closes; no GPU queries or allocations. */
  recordRendererFrame(backend: 'canvas' | 'webgl2'): void {
    if (this.enabled) {
      this.rendererFrames[backend]++;
    }
  }

  setGraphicsSettings(settings: Record<string, string | number | boolean>): void {
    this.graphicsSettings = { ...settings };
  }

  message(kind: string, payload: string, now: number): void {
    if (!this.enabled) {
      return;
    }
    this.messageBytes[kind] = (this.messageBytes[kind] ?? 0) + encoder.encode(payload).byteLength;
    this.messageCounts[kind] = (this.messageCounts[kind] ?? 0) + 1;
    if (this.lastMessageAt !== undefined) {
      this.record('messageGapMs', now - this.lastMessageAt);
    }
    this.lastMessageAt = now;
  }

  probe(now: number): number {
    for (const _id of this.pendingProbes.keys()) {
      this.count('unansweredProbes');
    }
    this.pendingProbes.clear();
    const id = ++this.probeSequence;
    if (this.enabled) {
      this.pendingProbes.set(id, now);
    }
    return id;
  }

  pong(id: unknown, now: number): void {
    if (!this.enabled) {
      return;
    }
    if (id === undefined) {
      this.count('barePongs');
      return;
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      this.count('invalidPongs');
      return;
    }
    const started = this.pendingProbes.get(id);
    if (started === undefined) {
      this.count(this.completedProbes.has(id) ? 'duplicatePongs' : 'stalePongs');
      return;
    }
    this.pendingProbes.delete(id);
    this.completedProbes.add(id);
    if (this.completedProbes.size > 64) {
      this.completedProbes.delete(this.completedProbes.values().next().value ?? id);
    }
    this.record('rttMs', now - started);
  }

  clearProbes(): void {
    for (const _id of this.pendingProbes.keys()) {
      this.count('unansweredProbes');
    }
    this.pendingProbes.clear();
    this.lastMessageAt = undefined;
  }

  private pendingInputAt: number | undefined;
  private authoritativeStateReady = false;
  private joinStartedAt: number | undefined;
  private recoveryStartedAt: number | undefined;
  private startedAt = this.phaseStartedAt;
  private nextExportAt = this.startedAt + 15_000;
  public serverReleaseId: string | undefined;

  constructor(public readonly enabled: boolean) {}

  setPhase(phase: Phase): void {
    const now = performance.now();
    if (this.enabled) {
      this.phaseDurations[this.phase] += now - this.phaseStartedAt;
    }
    this.phaseStartedAt = now;
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
      | 'inputEvents'
      | 'inputReleases'
      | 'inputCancellations'
      | 'unansweredProbes'
      | 'barePongs'
      | 'invalidPongs'
      | 'duplicatePongs'
      | 'stalePongs'
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

  input(now: number, kind: 'event' | 'release' | 'cancel' = 'event'): void {
    if (this.enabled && (this.phase === 'play' || this.phase === 'respawn')) {
      this.count('inputEvents');
      if (kind === 'release') {
        this.count('inputReleases');
      }
      if (kind === 'cancel') {
        this.count('inputCancellations');
        this.pendingInputAt = undefined;
        return;
      }
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

  reconnect(attempt: number, now: number): void {
    if (attempt === 1) {
      this.count('disconnects');
    }
    this.recover(now);
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

  read(reset = false, owner?: string) {
    if (reset && this.drainOwner !== undefined && owner !== this.drainOwner) {
      throw new Error(`Performance drain owned by ${this.drainOwner}`);
    }
    const now = performance.now();
    const renderer = this.rendererObserver?.();
    const result = {
      schemaVersion: 2,
      lastSnapshot: this.lastSnapshot ? { ...this.lastSnapshot } : undefined,
      appliedSnapshots: {
        count: this.appliedSnapshotCount,
        omittedSamples: this.appliedSnapshotCount - this.appliedSnapshots.length,
        values: this.appliedSnapshots.map((snapshot) => ({ ...snapshot })),
      },
      snapshotSession: this.snapshotSession,
      lastKeyframeSequence: this.lastKeyframeSequence,
      phaseDurationsMs: {
        ...this.phaseDurations,
        [this.phase]:
          this.phaseDurations[this.phase] + (this.enabled ? now - this.phaseStartedAt : 0),
      },
      messageBytes: { ...this.messageBytes },
      messageCounts: { ...this.messageCounts },
      graphicsSettings: { ...this.graphicsSettings },
      renderer: {
        requested: this.rendererRequested,
        backend: renderer?.backend ?? 'canvas',
        frames: { ...this.rendererFrames },
        gpuStats: renderer?.gpuStats ?? null,
      },
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
      this.appliedSnapshots.length = 0;
      this.appliedSnapshotCount = 0;
      this.series.clear();
      this.rendererFrames.canvas = 0;
      this.rendererFrames.webgl2 = 0;
      for (const phase of Object.keys(this.phaseDurations) as Phase[]) {
        this.phaseDurations[phase] = 0;
      }
      this.phaseStartedAt = now;
      for (const key of Object.keys(this.messageBytes)) {
        delete this.messageBytes[key];
      }
      for (const key of Object.keys(this.messageCounts)) {
        delete this.messageCounts[key];
      }
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
  for (const event of [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'keydown',
    'keyup',
  ]) {
    window.addEventListener(
      event,
      () =>
        clientPerformance.input(
          performance.now(),
          event === 'pointercancel'
            ? 'cancel'
            : event === 'pointerup' || event === 'keyup'
              ? 'release'
              : 'event'
        ),
      {
        capture: true,
        passive: true,
      }
    );
  }
  window.addEventListener('networkReconnecting', (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    if (
      typeof detail === 'object' &&
      detail !== null &&
      'attempt' in detail &&
      typeof detail.attempt === 'number'
    ) {
      clientPerformance.reconnect(detail.attempt, performance.now());
    }
  });
  window.addEventListener('networkPermanentlyDisconnected', () => {
    clientPerformance.joinFailed();
    clientPerformance.recoveryFailed();
  });
}

if (
  clientPerformance.enabled &&
  new URLSearchParams(window.location.search).get('performance') === 'collect'
) {
  const install = () => installPhoneCollector(clientPerformance);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}
