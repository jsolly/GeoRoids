import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  type Browser,
  type CDPSession,
  chromium,
  type Page,
  type Response as PlaywrightResponse,
  webkit,
} from 'playwright';
import { onDarkFurnaceFootprint } from '../shared/furnaceField';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../shared/snapshotProtocol';
import type { Position, ServerGameSnapshot } from '../shared-types';
import type { ClientPerformanceMetrics } from '../src/diagnostics/performanceMetrics';
import { PLAYFIELD_CLOSE_SCALE } from '../src/rendering/playfieldCamera';
import {
  type AppliedFreshness,
  appliedFreshness,
  type FreshnessObservation,
} from './applied-freshness';
import {
  finalizeServerWindow,
  prepareFixture,
  readRegionalManifest,
  readRegionalStatus,
  readServerProcessUsage,
  readSimulationClock,
  SimulationClockProbeError,
} from './fixture-control';
import { observesPreparedFixture } from './fixture-readiness';
import { LargeSnapshotEvidence } from './large-snapshot-evidence';
import {
  collectLiveReportMetadata,
  createLiveReport,
  errorRecord,
  validateHealth,
  writeLiveReport,
} from './live-report';
import { deliveryBudget, networkProfiles } from './network-profiles';
import { PerformanceBudget } from './performance-budget';
import { Pilot } from './pilot';
import { type ProxyCounters, readProxyCounters } from './proxy-control';
import {
  bindRegionalPilotOwner,
  RegionalDecodedWorkCache,
  RegionalScanSchedule,
  regionalSnapshotWork,
  requireAppliedRegionalWork,
  type ScanDecision,
} from './regional-scan-workload';
import type { Measurement } from './results';
import { errorRecord as serializeBenchmarkError } from './sample';
import { validateSnapshotTimingRequirements } from './snapshot-timing-requirements';
import {
  measureProxyTransport,
  measureServerProcessCpu,
  requireNegotiatedCompression,
} from './transport-qualification';
import { readBenchmarkCompression } from './websocket-compression';

const initialMetadata = collectLiveReportMetadata();

const TRACE_CATEGORIES = [
  'blink.user_timing',
  'cc',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-gpu.service',
  'disabled-by-default-skia',
  'disabled-by-default-v8.cpu_profiler',
  'gpu',
  'renderer.scheduler',
  'toplevel',
].join(',');
const TRACE_BUFFER_SIZE_KB = 256 * 1024;
const TRACE_MAX_BYTES = 256 * 1024 * 1024;
const TRACE_READ_SIZE = 1024 * 1024;
const TRACE_IO_READ_TIMEOUT_MS = 30_000;
const TRACE_COMPLETION_TIMEOUT_MS = 30_000;
const TRACE_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const TRACE_MAX_BUNDLE_TOTAL_BYTES = 128 * 1024 * 1024;
const TRACE_MAX_BUNDLES = 32;
const TRACE_BUNDLE_BODY_TIMEOUT_MS = 30_000;
const TRACE_MEASUREMENT_START_MARK = 'georoids-benchmark:measurement-start';
const TRACE_MEASUREMENT_END_MARK = 'georoids-benchmark:measurement-end';
const TRACE_MEASUREMENT_MEASURE = 'georoids-benchmark:measured-phase';

type TraceCompletion = {
  dataLossOccurred: boolean;
  stream?: string;
  streamCompression?: 'none' | 'gzip';
};

type TraceChunk = {
  base64Encoded?: boolean;
  data: string;
  eof: boolean;
};

type TraceCompletionWait = {
  cancel: (reason: unknown) => void;
  promise: Promise<TraceCompletion>;
};

type TraceArtifact = {
  bytes: number;
  complete: boolean;
  dataLossOccurred: boolean | null;
  streamCompression: 'none' | 'gzip';
};

type LoadedBundle = {
  advertisedBytes?: number;
  bytes: number;
  contentType: string;
  path: string;
  sha256: string;
  status: number;
  url: string;
};

class TraceCaptureError extends Error {
  readonly artifact: TraceArtifact;

  constructor(message: string, artifact: TraceArtifact, cause?: unknown) {
    const detail =
      cause instanceof AggregateError ? cause.errors.map(String).join('; ') : String(cause);
    super(cause === undefined ? message : `${message}: ${detail}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'TraceCaptureError';
    this.artifact = artifact;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function writeTraceChunk(file: FileHandle, chunk: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await file.write(chunk, offset, chunk.byteLength - offset, position + offset);
    assert(result.bytesWritten > 0, 'Trace writer made no progress');
    offset += result.bytesWritten;
  }
  return offset;
}

function waitForTraceCompletion(session: CDPSession): TraceCompletionWait {
  let finished = false;
  let rejectWait: (reason?: unknown) => void = () => undefined;
  let cleanupWait: () => void = () => undefined;
  const promise = new Promise<TraceCompletion>((resolve, reject) => {
    rejectWait = reject;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      session.off('Tracing.tracingComplete', onComplete);
      session.off('close', onClose);
    };
    cleanupWait = cleanup;
    const onComplete = (payload: TraceCompletion) => {
      finished = true;
      cleanup();
      resolve(payload);
    };
    const onClose = () => {
      finished = true;
      cleanup();
      reject(new Error('Chromium CDP session closed before tracing completed'));
    };
    timer = setTimeout(() => {
      finished = true;
      cleanup();
      reject(new Error('Chromium tracing did not complete within 30 seconds'));
    }, TRACE_COMPLETION_TIMEOUT_MS);
    session.once('Tracing.tracingComplete', onComplete);
    session.once('close', onClose);
  });
  return {
    promise,
    cancel(reason) {
      if (finished) {
        return;
      }
      finished = true;
      cleanupWait();
      rejectWait(reason);
    },
  };
}

async function stopAndSaveTrace(session: CDPSession, outputPath: string): Promise<TraceArtifact> {
  const completion = waitForTraceCompletion(session);
  const ending = Promise.resolve().then(() =>
    withTimeout(session.send('Tracing.end'), TRACE_COMPLETION_TIMEOUT_MS, 'Chromium Tracing.end')
  );
  let result: TraceCompletion;
  try {
    [, result] = await Promise.all([ending, completion.promise]);
  } catch (error) {
    completion.cancel(error);
    throw error;
  } finally {
    // Promise.all attaches rejection handlers to both operations immediately;
    // cancellation also removes the event/timer when either operation fails.
    completion.cancel(new Error('Tracing completion no longer required'));
  }
  const artifact: TraceArtifact = {
    bytes: 0,
    complete: false,
    dataLossOccurred: result.dataLossOccurred,
    streamCompression: result.streamCompression ?? 'none',
  };
  if (!result.stream) {
    throw new TraceCaptureError('Chromium tracing completed without a stream', artifact);
  }
  let file: FileHandle | undefined;
  let operationFailure: unknown;
  let operationFailed = false;
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    file = await open(outputPath, 'w');
    let eof = false;
    while (!eof) {
      const chunk: TraceChunk = await withTimeout(
        session.send('IO.read', {
          handle: result.stream,
          size: TRACE_READ_SIZE,
        }),
        TRACE_IO_READ_TIMEOUT_MS,
        'Chromium trace IO.read'
      );
      const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      assert(data.byteLength > 0 || chunk.eof, 'Chromium trace stream made no progress');
      assert(
        artifact.bytes + data.byteLength <= TRACE_MAX_BYTES,
        `Browser trace exceeded ${TRACE_MAX_BYTES} bytes`
      );
      artifact.bytes += await writeTraceChunk(file, data, artifact.bytes);
      eof = chunk.eof;
    }
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }
  const cleanupFailures: unknown[] = [];
  if (file) {
    try {
      await file.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await withTimeout(
      session.send('IO.close', { handle: result.stream }),
      TRACE_IO_READ_TIMEOUT_MS,
      'Chromium trace IO.close'
    );
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (operationFailed) {
    const failure =
      cleanupFailures.length > 0
        ? new AggregateError(
            [operationFailure, ...cleanupFailures],
            'Trace write or cleanup failed'
          )
        : operationFailure;
    throw new TraceCaptureError('Trace capture failed', artifact, failure);
  }
  if (cleanupFailures.length > 0) {
    throw new TraceCaptureError(
      'Trace cleanup failed',
      artifact,
      new AggregateError(cleanupFailures, 'Trace cleanup failed')
    );
  }
  artifact.complete = true;
  return artifact;
}

type ActiveTraceSession = {
  session: CDPSession | undefined;
  started: boolean;
};

function assignTraceArtifact(artifact: TraceArtifact): void {
  traceArtifact = artifact;
}

function createTraceStopper(
  runtime: ActiveTraceSession,
  outputPath: string | undefined,
  onArtifact: (artifact: TraceArtifact) => void
) {
  return async () => {
    const artifact = await stopActiveTraceSession(runtime, outputPath);
    if (artifact) {
      onArtifact(artifact);
    }
  };
}

async function stopActiveTraceSession(
  runtime: ActiveTraceSession,
  outputPath: string | undefined
): Promise<TraceArtifact | undefined> {
  if (!runtime.session) {
    return undefined;
  }
  let capturedArtifact: TraceArtifact | undefined;
  const session = runtime.session;
  runtime.session = undefined;
  let stopFailure: unknown;
  let stopFailed = false;
  try {
    if (runtime.started) {
      assert(outputPath);
      try {
        const artifact = await stopAndSaveTrace(session, outputPath);
        capturedArtifact = artifact;
        assert(!artifact.dataLossOccurred, 'Chromium tracing reported data loss');
      } catch (error) {
        if (error instanceof TraceCaptureError) {
          capturedArtifact = error.artifact;
        }
        stopFailed = true;
        stopFailure = error;
      }
    }
  } finally {
    runtime.started = false;
  }
  let detachFailure: unknown;
  let detachFailed = false;
  try {
    await withTimeout(session.detach(), TRACE_COMPLETION_TIMEOUT_MS, 'Chromium tracing CDP detach');
  } catch (error) {
    detachFailed = true;
    detachFailure = error;
  }
  if (stopFailed) {
    if (detachFailed) {
      throw new AggregateError([stopFailure, detachFailure], 'Trace stop or detach failed');
    }
    throw stopFailure;
  }
  if (detachFailed) {
    throw detachFailure;
  }
  return capturedArtifact;
}

function advertisedContentLength(response: PlaywrightResponse): number | undefined {
  const value = response.headers()['content-length'];
  if (value === undefined) {
    return undefined;
  }
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

function bundleFileName(url: string, sha256: string): string {
  const name = new URL(url).pathname.split('/').at(-1) || 'bundle.js';
  const safeName = name.replace(/[^A-Za-z0-9._-]/gu, '_');
  return `${safeName}-${sha256}.js`;
}

async function saveLoadedBundle(
  response: PlaywrightResponse,
  outputDirectory: string,
  totalBytes: number
): Promise<LoadedBundle> {
  const advertisedBytes = advertisedContentLength(response);
  if (advertisedBytes !== undefined) {
    assert(
      advertisedBytes <= TRACE_MAX_BUNDLE_BYTES,
      `Advertised JavaScript bundle exceeded ${TRACE_MAX_BUNDLE_BYTES} bytes`
    );
    assert(
      totalBytes + advertisedBytes <= TRACE_MAX_BUNDLE_TOTAL_BYTES,
      `Advertised JavaScript bundles exceeded ${TRACE_MAX_BUNDLE_TOTAL_BYTES} bytes`
    );
  }
  const body = await withTimeout(
    response.body(),
    TRACE_BUNDLE_BODY_TIMEOUT_MS,
    `JavaScript bundle response ${response.url()}`
  );
  assert(
    body.byteLength <= TRACE_MAX_BUNDLE_BYTES,
    `Loaded JavaScript bundle exceeded ${TRACE_MAX_BUNDLE_BYTES} bytes`
  );
  assert(
    totalBytes + body.byteLength <= TRACE_MAX_BUNDLE_TOTAL_BYTES,
    `Loaded JavaScript bundles exceeded ${TRACE_MAX_BUNDLE_TOTAL_BYTES} bytes`
  );
  const url = response.url();
  const sha256 = createHash('sha256').update(body).digest('hex');
  const path = join(outputDirectory, bundleFileName(url, sha256));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path, body);
  return {
    ...(advertisedBytes !== undefined ? { advertisedBytes } : {}),
    url,
    status: response.status(),
    contentType: response.headers()['content-type'] ?? '',
    bytes: body.byteLength,
    sha256,
    path,
  };
}

const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '180' },
    warmup: { type: 'string', default: '30' },
    viewport: { type: 'string', default: 'all' },
    browser: { type: 'string', default: 'chromium' },
    output: { type: 'string', default: '.performance/client.json' },
    dpr: { type: 'string', default: '1' },
    'cpu-slowdown': { type: 'string', default: '1' },
    network: { type: 'string', default: 'clean' },
    seed: { type: 'string', default: '42' },
    scenario: { type: 'string', default: 'traversal' },
    'render-dpr': { type: 'string', default: 'native' },
    'render-glow': { type: 'string', default: 'full' },
    renderer: { type: 'string', default: 'canvas' },
    'cpu-profile': { type: 'string' },
    trace: { type: 'string' },
    'chromium-gpu': { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
  },
});
assert(
  !values['cpu-profile'] || (values.browser === 'chromium' && values.viewport !== 'all'),
  'CPU profiling requires Chromium and one viewport'
);
assert(
  !values.trace || (values.browser === 'chromium' && values.viewport !== 'all'),
  'Browser tracing requires Chromium and one viewport'
);
const chromiumGpu = values['chromium-gpu'];
const headed = values.headed;
assert(!chromiumGpu || values.browser === 'chromium', 'chromium-gpu requires Chromium');
const browserLaunchArgs = chromiumGpu ? ['--enable-gpu'] : [];
const dpr = Number(values.dpr);
const cpuSlowdown = Number(values['cpu-slowdown']);
const seed = Number(values.seed);
const network = values.network;
const workload = values.scenario;
const renderer = values.renderer;
assert(renderer === 'canvas' || renderer === 'webgl2', 'renderer must be canvas or webgl2');
assert(Number.isFinite(dpr) && dpr >= 1 && dpr <= 4, 'dpr must be 1..4');
assert([1, 4, 6].includes(cpuSlowdown), 'cpu-slowdown must be 1, 4, or 6');
assert(
  Number.isSafeInteger(seed) && seed > 0 && seed === Number(process.env['GEOROIDS_BENCHMARK_SEED']),
  'seed must match owned server'
);
assert(network === 'clean' || network === 'normal' || network === 'degraded', 'Unknown network');
assert(
  workload === 'traversal' ||
    workload === 'combat' ||
    workload === 'dense-combat' ||
    workload === 'regional-combat',
  'Unknown scenario'
);
const combatWorkload = workload !== 'traversal';
const compression = readBenchmarkCompression(process.env['GEOROIDS_BENCHMARK_COMPRESSION']);
const regionalWorkload = workload === 'regional-combat';
assert(['native', '2', '1.5'].includes(values['render-dpr']), 'Invalid render-dpr');
assert(['full', 'off'].includes(values['render-glow']), 'Invalid render-glow');
assert(values.browser === 'chromium' || cpuSlowdown === 1, 'CPU slowdown requires Chromium');
assert(
  values.browser === 'chromium' || values.viewport === 'desktop',
  'Trusted simultaneous touch requires Chromium; use physical Safari for touch'
);
const sessionPath = process.env['GEOROIDS_BENCHMARK_SESSION'];
assert(sessionPath, 'Run through scripts/test-runner.sh --benchmark-client');
const ownedSessionPath = sessionPath;
const fixtureScenario = workload;
const socketUrl = process.env['GEOROIDS_BENCHMARK_WS_URL'];
assert(socketUrl, 'Missing owned gameplay endpoint');
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
assert(Number.isFinite(seconds) && seconds >= 1 && seconds <= 1800, 'seconds must be 1..1800');
assert(Number.isFinite(warmup) && warmup >= 0 && warmup <= 300, 'warmup must be 0..300');
assert(
  values.browser === 'chromium' || values.browser === 'webkit',
  'browser must be chromium or webkit'
);
const browserChannel =
  values.browser === 'chromium' ? (chromiumGpu ? 'chromium' : 'playwright-bundled') : 'webkit';
const cases = [
  { name: 'desktop', viewport: { width: 1920, height: 1080 }, hasTouch: false },
  { name: 'touch-portrait', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: 'touch-landscape', viewport: { width: 844, height: 390 }, hasTouch: true },
].filter((item) => values.viewport === 'all' || values.viewport === item.name);
assert(cases.length > 0, 'Unknown viewport');
assert(
  !regionalWorkload || cases.length === 1,
  'Regional combat requires one viewport in a fresh owned server session'
);
const origin = `http://127.0.0.1:${process.env['GEOROIDS_TEST_VITE_PORT'] ?? 5173}`;
const healthUrl = `http://127.0.0.1:${process.env['GEOROIDS_TEST_SERVER_PORT'] ?? 3001}/health`;
type Interval = ReturnType<ClientPerformanceMetrics['read']>;

function requireMeasuredRenderer(interval: Interval): void {
  // Frozen harnesses may also run older Canvas products without this observer.
  // Renderer experiments reject those legacy reports in the comparison tool.
  if (!('renderer' in interval)) {
    assert.equal(renderer, 'canvas', 'WebGL2 measurement requires actual renderer observations');
    return;
  }
  const observation = interval.renderer;
  assert(observation && typeof observation === 'object', 'Missing actual renderer observation');
  const observed = Object.fromEntries(Object.entries(observation));
  assert.equal(observed['requested'], renderer, 'Observed renderer request differs from selector');
  assert.equal(observed['backend'], renderer, 'Requested renderer is not the active backend');
  const frames = observed['frames'];
  assert(frames && typeof frames === 'object', 'Missing renderer frame ledger');
  const counts = Object.fromEntries(Object.entries(frames));
  let observedFrames = 0;
  for (const mode of ['canvas', 'webgl2']) {
    const count = counts[mode];
    assert(
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
      'Invalid renderer frame count'
    );
    observedFrames += count;
  }
  const timedFrames = Object.entries(interval.metrics)
    .filter(([name]) => name.endsWith('.frameCpuMs'))
    .reduce((total, [, metric]) => total + metric.count, 0);
  assert.equal(
    observedFrames,
    timedFrames,
    'Actual renderer observations do not cover every timed frame'
  );
  assert.equal(
    counts[renderer === 'canvas' ? 'webgl2' : 'canvas'],
    0,
    'Renderer fell back or changed during measurement'
  );
}
const runs: Array<Record<string, unknown>> = [];
const failures: unknown[] = [];
const measuredIntervals: Interval[] = [];
const joinIntervals: Interval[] = [];
const measurementSetupIntervals: Interval[] = [];
let browser: Browser | undefined;
let browserVersion = 'unknown';
let cleanupComplete = true;
let gpu: object = { supported: false, reason: 'SystemInfo unavailable in WebKit' };
let profileRecorded = Boolean(values.trace);
let traceArtifact: TraceArtifact | undefined;
const tracePath = values.trace;
const traceBundleDirectory = tracePath ? `${tracePath}.bundles` : undefined;
const traceBundleManifest = traceBundleDirectory
  ? join(traceBundleDirectory, 'manifest.json')
  : undefined;

function metricSamples(suffix: string): number[] {
  const intervals =
    suffix === 'joinMs' ? [...joinIntervals, ...measuredIntervals] : measuredIntervals;
  return intervals.flatMap((interval) =>
    Object.entries(interval.metrics)
      .filter(([name]) => name.endsWith(`.${suffix}`))
      .flatMap(([, metric]) => metric.values)
  );
}

function createMeasurement(): Measurement | undefined {
  const samples: Record<string, number[]> = {};
  for (const name of [
    'frameIntervalMs',
    'frameCpuMs',
    'updateMs',
    'renderMs',
    'parseMs',
    'keyframeDecodeMs',
    'deltaDecodeMs',
    'applyMs',
    'joinMs',
    'recoveryMs',
    'inputToRenderMs',
  ]) {
    const metricValues = metricSamples(name);
    if (metricValues.length > 0) {
      samples[name] = metricValues;
    }
  }
  const primaryMetric = samples['frameCpuMs']
    ? 'frameCpuMs'
    : samples['renderMs']
      ? 'renderMs'
      : Object.keys(samples)[0];
  try {
    validateSnapshotTimingRequirements([
      { phase: 'join', intervals: joinIntervals },
      { phase: 'warmup', intervals: measurementSetupIntervals },
      { phase: 'measured', intervals: measuredIntervals },
    ]);
  } catch (error) {
    failures.push(error);
  }
  const requiredMetrics = ['parseMs', 'deltaDecodeMs', 'applyMs', 'joinMs'];
  for (const name of requiredMetrics) {
    if (!samples[name]) {
      failures.push(new Error(`Real-time client report is missing ${name} samples`));
    }
  }
  if (!primaryMetric) {
    return undefined;
  }
  return {
    primaryMetric,
    samples,
    counts: {
      scenarioRuns: runs.length,
      successfulScenarios: runs.filter((run) => run['status'] === 'passed').length,
      failedScenarios: runs.filter((run) => run['status'] === 'failed').length,
      measuredIntervals: measuredIntervals.length,
      rawSamples: Object.values(samples).reduce(
        (sum, sampleValues) => sum + sampleValues.length,
        0
      ),
    },
    parameters: {
      browser: values.browser,
      browserChannel,
      headed,
      dpr,
      cpuSlowdown,
      network,
      seed,
      workload,
      profileRecorded,
      compression: compression.mode,
      renderDpr: values['render-dpr'],
      renderGlow: values['render-glow'],
      renderer,
      build: 'production',
      warmupSeconds: warmup,
      measuredSeconds: seconds,
      viewports: cases.map((scenario) => scenario.name),
      timing: 'native requestAnimationFrame timestamps and synchronous CPU submission',
      presentation: 'Animation timestamps do not prove GPU presentation or frame rate',
    },
    witness: {
      scenarios: runs.map((run) => run['scenario']),
      releases: runs.map((run) => run['metadata'] ?? null),
      measuredFrames: samples['frameCpuMs']?.length ?? 0,
    },
    cleanup: 'complete',
  };
}

function drain(page: Page): Promise<Interval> {
  return page.evaluate(() => {
    assertAvailable();
    function assertAvailable() {
      if (!window.georoidsPerformance) {
        throw new Error('Production performance recorder missing');
      }
    }
    const recorder = window.georoidsPerformance;
    if (!recorder) {
      throw new Error('Production performance recorder missing');
    }
    recorder.claimDrain('benchmark');
    const panel = document.querySelector<HTMLElement>("aside[aria-label='Performance collection']");
    if (panel) {
      panel.hidden = true;
    }
    return recorder.read(true, 'benchmark');
  });
}

try {
  browser = await (values.browser === 'webkit' ? webkit : chromium).launch({
    headless: !headed,
    args: browserLaunchArgs,
    ...(chromiumGpu ? { channel: 'chromium' } : {}),
  });
  browserVersion = browser.version();
  const activeBrowser = browser;
  if (values.browser === 'chromium') {
    const systemSession = await activeBrowser.newBrowserCDPSession();
    try {
      const info = await systemSession.send('SystemInfo.getInfo');
      if (chromiumGpu) {
        for (const feature of ['2d_canvas', 'gpu_compositing', 'rasterization']) {
          const status = info.gpu.featureStatus?.[feature];
          assert(
            status === 'enabled' || status === 'enabled_on',
            `Requested GPU path lacks accelerated ${feature}: ${status}`
          );
        }
        const hardwareRenderer = info.gpu.auxAttributes?.['glRenderer'];
        assert(
          typeof hardwareRenderer === 'string' &&
            hardwareRenderer.length > 0 &&
            !/swiftshader|llvmpipe|software/iu.test(hardwareRenderer),
          'Requested GPU path lacks an observed hardware renderer'
        );
      }
      gpu = {
        supported: true,
        devices: info.gpu.devices,
        renderer: Object.fromEntries(
          Object.entries(info.gpu.auxAttributes ?? {}).filter(([key]) =>
            [
              'glRenderer',
              'glVendor',
              'glVersion',
              'displayType',
              'passthroughCmdDecoder',
            ].includes(key)
          )
        ),
        featureStatus: info.gpu.featureStatus,
      };
    } finally {
      await systemSession.detach();
    }
  }
  for (const scenario of cases) {
    process.stdout.write(`Starting ${scenario.name}: ${warmup}s warmup, ${seconds}s measurement\n`);
    const errors: string[] = [];
    const warnings: string[] = [];
    const intervals: Interval[] = [];
    const warmupIntervals: Interval[] = [];
    const restarts: Array<{
      kind: 'browser-respawn' | 'peer-rejoin';
      startedAt: number;
      durationMs: number;
    }> = [];
    const health: unknown[] = [];
    const closedWindowIds = new Set<string>();
    const finalizedHealth: unknown[] = [];
    const peers: Pilot[] = [];
    let measuring = false;
    let arranging = false;
    let peerTimer: ReturnType<typeof setInterval> | undefined;
    const sockets: string[] = [];
    let measuredPilotId: string | undefined;
    let preparedBrowserSession: number | undefined;
    let acknowledgedMotionStates = 0;
    let lastMotionAck = '';
    const observedProjectiles = new Set<string>();
    let measurementGameTime = 0;
    let warmupSnapshotBytes = 0;
    let warmupSnapshotCount = 0;
    const performanceBudget = new PerformanceBudget();
    let delivery = deliveryBudget(network, 1);
    let stateMeasuredStarted = 0;
    let measurementStoppedAt = 0;
    let browserMeasurementStartedAt: number | undefined;
    const largeSnapshots = new LargeSnapshotEvidence();
    type BoundaryProbe = {
      boundary: 'start' | 'end';
      startedAt: number;
      endedAt: number | null;
      failure: ReturnType<typeof serializeBenchmarkError> | null;
    };
    const proxyTransport: {
      start: ProxyCounters | null;
      end: ProxyCounters | null;
      measurement: ReturnType<typeof measureProxyTransport> | null;
      probes: BoundaryProbe[];
    } = { start: null, end: null, measurement: null, probes: [] };
    async function sampleProxyTransport(boundary: 'start' | 'end') {
      const probe: BoundaryProbe = {
        boundary,
        startedAt: performance.now(),
        endedAt: null,
        failure: null,
      };
      proxyTransport.probes.push(probe);
      try {
        return await readProxyCounters(join(ownedSessionPath, 'proxy.sock'));
      } catch (error) {
        probe.failure = serializeBenchmarkError(error);
        throw error;
      } finally {
        probe.endedAt = performance.now();
      }
    }
    const serverProcessCpu: {
      start: Awaited<ReturnType<typeof readServerProcessUsage>> | null;
      end: Awaited<ReturnType<typeof readServerProcessUsage>> | null;
      measurement: ReturnType<typeof measureServerProcessCpu> | null;
      probes: BoundaryProbe[];
    } = { start: null, end: null, measurement: null, probes: [] };
    async function sampleServerProcessCpu(boundary: 'start' | 'end') {
      const probe: BoundaryProbe = {
        boundary,
        startedAt: performance.now(),
        endedAt: null,
        failure: null,
      };
      serverProcessCpu.probes.push(probe);
      try {
        return await readServerProcessUsage(join(ownedSessionPath, 'fixture.sock'));
      } catch (error) {
        probe.failure = serializeBenchmarkError(error);
        throw error;
      } finally {
        probe.endedAt = performance.now();
      }
    }
    async function captureMeasurementBoundary(boundary: 'start' | 'end') {
      // Independent private probes start together; each keeps its own query
      // bracket and raw reply even if the other endpoint rejects or times out.
      const results = await Promise.allSettled([
        sampleProxyTransport(boundary).then((counters) => {
          proxyTransport[boundary] = counters;
        }),
        sampleServerProcessCpu(boundary).then((usage) => {
          serverProcessCpu[boundary] = usage;
        }),
      ]);
      const boundaryFailures: unknown[] = [];
      for (const result of results) {
        if (result.status === 'rejected') {
          boundaryFailures.push(result.reason);
        }
      }
      return boundaryFailures;
    }
    let measuredSnapshotBytes = 0;
    let lastMeasuredStateAt = 0;
    const stateGaps: Array<{ from: number; to: number; durationMs: number }> = [];
    const freshnessSamples: Array<{
      index: number;
      measured: boolean;
      phase: 'steady' | 'recovery';
      collectionStartedAt: number;
      appliedObservedAt: number;
      queryStartedAt: number;
      queryEndedAt: number;
      queryDurationMs: number;
      clock: Awaited<ReturnType<typeof readSimulationClock>> | null;
      observations: FreshnessObservation[];
      clients: AppliedFreshness[];
      failure: string | null;
      probeFailure: {
        error: ReturnType<typeof serializeBenchmarkError>;
        response: SimulationClockProbeError['response'];
      } | null;
    }> = [];
    const previousFreshness = new Map<string, FreshnessObservation>();
    let previousSimulationClock: Awaited<ReturnType<typeof readSimulationClock>> | undefined;
    let freshnessAttempts = 0;
    let omittedFreshnessSamples = 0;
    let lastFreshnessRestartCount = 0;
    function freshnessReport() {
      const measured = freshnessSamples.filter((sample) => sample.measured);
      return {
        policy:
          'server clock minus successfully applied snapshot clock; query follows applied observation',
        maximumServerToAppliedMs: delivery.maximumStateGapMs,
        retainedLimit: 4096,
        attemptedSamples: freshnessAttempts,
        retainedSamples: freshnessSamples.length,
        omittedSamples: omittedFreshnessSamples,
        clientObservations: freshnessSamples.reduce(
          (count, sample) => count + sample.observations.length,
          0
        ),
        validClients: freshnessSamples.reduce(
          (count, sample) =>
            count + sample.clients.filter((client) => client.kind === 'valid').length,
          0
        ),
        measuredSamples: measured.length,
        measuredClientObservations: measured.reduce(
          (count, sample) => count + sample.observations.length,
          0
        ),
        measuredValidClients: measured.reduce(
          (count, sample) =>
            count + sample.clients.filter((client) => client.kind === 'valid').length,
          0
        ),
        samples: freshnessSamples,
      };
    }
    let latestAuthoritativeState: ServerGameSnapshot | undefined;
    const populationSamples: unknown[] = [];
    const regionalStatusSamples: Array<{
      measured: boolean;
      startedAt: number;
      endedAt: number;
      status: Awaited<ReturnType<typeof readRegionalStatus>> | null;
      failure: ReturnType<typeof errorRecord> | null;
      freshnessSampleIndex: number;
      peerAsteroidRows: Array<{ id: string; rows: number }>;
    }> = [];
    let regionalFinalManifest: Awaited<ReturnType<typeof readRegionalManifest>> | undefined;
    let regionalFinalManifestAttempted = false;
    let regionalFinalManifestFailure: ReturnType<typeof errorRecord> | undefined;
    const regionalWork = {
      snapshotStates: 0,
      normalStates: 0,
      scanStates: 0,
      expandedScanStates: 0,
      statesWithoutAsteroids: 0,
      minAsteroids: 0,
      maxAsteroids: 0,
      warmupScanStates: 0,
      warmupExpandedScanStates: 0,
      appliedNormalStates: 0,
      appliedScanStates: 0,
      appliedExpandedScanStates: 0,
    };
    const regionalScanSchedule = new RegionalScanSchedule();
    const regionalDecodedWork = new RegionalDecodedWorkCache();
    let previousRegionalApplication: Interval['appliedSnapshots']['values'][number] | undefined;
    const regionalScanEvidence = {
      policy:
        'Pending natural scan retries at the next input slot after authoritative cooldown and UI readiness; work requires successful client application.',
      retainedLimit: 4096,
      appliedRetainedLimit: 60_000,
      attempts: [] as Array<{
        step: number;
        measured: boolean;
        decision: ScanDecision;
        uiReady: boolean;
        authoritativeCooldownFrames: number | undefined;
        authoritativeGameTime: number | undefined;
        uiLabel: string | null;
        dispatched: boolean;
      }>,
      accepted: [] as Array<{
        measured: boolean;
        observedAt: number;
        abilityActiveFrames: number | null;
      }>,
      requests: [] as Array<{ measured: boolean; observedAt: number }>,
      applied: [] as Array<{
        measured: boolean;
        session: number;
        work: NonNullable<ReturnType<typeof regionalSnapshotWork>>;
      }>,
    };
    let sampledCamera:
      | { position: Position; width: number; height: number; observedAtMs: number }
      | undefined;
    let previousHealth:
      | { entities: Map<string, number>; asteroids: Map<string, number> }
      | undefined;
    function viewportWitness(position: Position | undefined, observedAtMs: number) {
      if (!sampledCamera || !position) {
        return { relation: 'unknown' };
      }
      const inside =
        Math.abs(position.x - sampledCamera.position.x) * PLAYFIELD_CLOSE_SCALE <=
          sampledCamera.width / 2 &&
        Math.abs(position.y - sampledCamera.position.y) * PLAYFIELD_CLOSE_SCALE <=
          sampledCamera.height / 2;
      return {
        relation: inside ? 'inside-last-sampled-viewport' : 'outside-last-sampled-viewport',
        cameraSampleAgeMs: observedAtMs - sampledCamera.observedAtMs,
      };
    }
    const healthDecreases: Array<{
      observedAtMs: number;
      gameTime: number;
      snapshotSequence: number;
      collection: 'entities' | 'asteroids';
      id: string;
      before: number;
      after: number;
      position: Position;
      viewport: ReturnType<typeof viewportWitness>;
    }> = [];
    const authoritativeEvents: Array<Record<string, unknown>> = [];
    const combatWitness = {
      healthDecreaseCounts: { entities: 0, asteroids: 0 },
      authoritativeEventCounts: {
        asteroidDestroy: 0,
        shockwave: 0,
        playerDamaged: 0,
        asteroidTagged: 0,
      },
      healthDecreases,
      authoritativeEvents,
      omittedHealthDecreases: 0,
      omittedAuthoritativeEvents: 0,
      retainedLimitPerSeries: 4096,
    };
    let inputSteps = 0;
    const inputSchedule: Array<{
      scheduledAt: number;
      startedAt: number;
      missedSlots: number;
      measured: boolean;
    }> = [];
    const inputActions: Array<{
      startedAt: number;
      completedAt: number | undefined;
      measured: boolean;
    }> = [];
    let metadata: Record<string, unknown> | undefined;
    let joined: Interval | undefined;
    let traceMeasurementStarted = false;
    let traceMeasurementEndAttempted = false;
    const constraints: Record<string, unknown> = {
      browserChannel,
      headed,
      dpr,
      cpuSlowdown,
      chromiumGpu,
      network,
      seed,
      workload,
      sockets,
      compressionRequested: compression,
    };
    const fixtures: Array<Awaited<ReturnType<typeof prepareFixture>>> = [];
    const context = await activeBrowser.newContext({
      viewport: scenario.viewport,
      hasTouch: scenario.hasTouch,
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    if (headed) {
      await page.bringToFront();
    }
    const loadedBundles: LoadedBundle[] = [];
    const capturedBundleUrls = new Set<string>();
    const bundleCaptureFailures: unknown[] = [];
    let bundleCaptureTail = Promise.resolve();
    let bundleBytes = 0;
    let bundleLimitReported = false;
    let traceBundleManifestSaved = false;
    if (tracePath && traceBundleDirectory && traceBundleManifest) {
      page.on('response', (response) => {
        const request = response.request();
        const url = response.url();
        if (request.resourceType() !== 'script' || new URL(url).origin !== origin) {
          return;
        }
        if (capturedBundleUrls.has(url)) {
          return;
        }
        if (capturedBundleUrls.size >= TRACE_MAX_BUNDLES) {
          if (!bundleLimitReported) {
            bundleLimitReported = true;
            bundleCaptureFailures.push(
              new Error(`Loaded more than ${TRACE_MAX_BUNDLES} same-origin JavaScript bundles`)
            );
          }
          return;
        }
        capturedBundleUrls.add(url);
        bundleCaptureTail = bundleCaptureTail
          .then(async () => {
            const bundle = await saveLoadedBundle(response, traceBundleDirectory, bundleBytes);
            bundleBytes += bundle.bytes;
            loadedBundles.push(bundle);
          })
          .catch((error: unknown) => {
            bundleCaptureFailures.push(
              new Error(`Failed to retain loaded JavaScript bundle ${url}`, { cause: error })
            );
          });
      });
    }
    async function saveTraceBundles(): Promise<void> {
      if (!traceBundleDirectory || !traceBundleManifest || traceBundleManifestSaved) {
        return;
      }
      await bundleCaptureTail;
      await mkdir(traceBundleDirectory, { recursive: true });
      await writeFile(
        traceBundleManifest,
        JSON.stringify(
          {
            schemaVersion: 1,
            tracePath,
            capturePolicy: {
              traceIoReadTimeoutMs: TRACE_IO_READ_TIMEOUT_MS,
              maxBundleBytes: TRACE_MAX_BUNDLE_BYTES,
              maxTotalBytes: TRACE_MAX_BUNDLE_TOTAL_BYTES,
              maxBundles: TRACE_MAX_BUNDLES,
              responseBodyTimeoutMs: TRACE_BUNDLE_BODY_TIMEOUT_MS,
              contentLengthPrecheck:
                'Valid Content-Length is checked before response.body(); decoded bodies are checked again after allocation when the header is absent or encoded.',
            },
            bundles: loadedBundles,
            captureErrors: bundleCaptureFailures.map((error) => errorRecord(error)),
          },
          null,
          2
        )
      );
      traceBundleManifestSaved = true;
      if (bundleCaptureFailures.length > 0) {
        throw new AggregateError(bundleCaptureFailures, 'JavaScript bundle retention failed');
      }
      assert(loadedBundles.length > 0, 'No same-origin JavaScript bundles captured');
    }
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== '/ws') {
        return;
      }
      sockets.push(socket.url());
      const decoder = new SnapshotDecoder();
      let sequence = 0;
      let acceptSnapshots = false;
      socket.on('framesent', ({ payload }) => {
        if (!regionalWorkload) {
          return;
        }
        try {
          const text = typeof payload === 'string' ? payload : payload.toString();
          if (!text.includes('"useAbility"')) {
            return;
          }
          const envelope: unknown = JSON.parse(text);
          if (
            envelope &&
            typeof envelope === 'object' &&
            'type' in envelope &&
            envelope.type === 'useAbility' &&
            'id' in envelope &&
            envelope.id === measuredPilotId
          ) {
            assert(
              regionalScanEvidence.requests.length < 4096,
              'Regional ability request bound exceeded'
            );
            regionalScanEvidence.requests.push({
              measured: measuring,
              observedAt: performance.now(),
            });
          }
        } catch (error) {
          errors.push(String(error));
        }
      });
      socket.on('framereceived', ({ payload }) => {
        try {
          const text = typeof payload === 'string' ? payload : payload.toString();
          const result = decoder.readMessage(text, { acceptSnapshots });
          if (result.kind === 'snapshot-rejected') {
            throw result.error;
          }
          if (result.kind === 'message') {
            const envelope = result.message;
            if (
              !envelope ||
              typeof envelope !== 'object' ||
              !('type' in envelope) ||
              !('data' in envelope)
            ) {
              return;
            }
            if (envelope.type === 'joined') {
              if (regionalWorkload) {
                measuredPilotId = bindRegionalPilotOwner(envelope.data, measuredPilotId);
              }
              decoder.reset();
              sequence = 0;
              acceptSnapshots = true;
              previousHealth = undefined;
            }
            if (
              regionalWorkload &&
              envelope.type === 'abilityUsed' &&
              envelope.data &&
              typeof envelope.data === 'object' &&
              'id' in envelope.data &&
              envelope.data.id === measuredPilotId
            ) {
              assert(
                regionalScanEvidence.accepted.length < 4096,
                'Regional ability event bound exceeded'
              );
              regionalScanEvidence.accepted.push({
                measured: measuring,
                observedAt: performance.now(),
                abilityActiveFrames:
                  'abilityActiveFrames' in envelope.data &&
                  typeof envelope.data.abilityActiveFrames === 'number'
                    ? envelope.data.abilityActiveFrames
                    : null,
              });
            }
            if (
              measuring &&
              !arranging &&
              (envelope.type === 'asteroidDestroy' ||
                envelope.type === 'shockwave' ||
                envelope.type === 'playerDamaged' ||
                envelope.type === 'asteroidTagged')
            ) {
              const data = envelope.data;
              assert(data && typeof data === 'object', 'Invalid authoritative combat event');
              const asteroidId =
                'asteroidId' in data && typeof data.asteroidId === 'string'
                  ? data.asteroidId
                  : undefined;
              let targetPlayerId: string | undefined;
              let hitDetails: Record<string, unknown> = {};
              if (envelope.type === 'playerDamaged') {
                assert(
                  'targetPlayerId' in data &&
                    typeof data.targetPlayerId === 'string' &&
                    'attackerId' in data &&
                    typeof data.attackerId === 'string' &&
                    'damage' in data &&
                    typeof data.damage === 'number' &&
                    Number.isFinite(data.damage) &&
                    'remainingHealth' in data &&
                    typeof data.remainingHealth === 'number' &&
                    Number.isFinite(data.remainingHealth) &&
                    'isDestroyed' in data &&
                    typeof data.isDestroyed === 'boolean',
                  'Invalid authoritative player damage'
                );
                targetPlayerId = data.targetPlayerId;
                hitDetails = {
                  targetPlayerId,
                  attackerId: data.attackerId,
                  damage: data.damage,
                  remainingHealth: data.remainingHealth,
                  isDestroyed: data.isDestroyed,
                };
              } else if (envelope.type === 'asteroidTagged') {
                assert(
                  asteroidId &&
                    'shooterId' in data &&
                    typeof data.shooterId === 'string' &&
                    'expiresAt' in data &&
                    typeof data.expiresAt === 'number' &&
                    Number.isFinite(data.expiresAt),
                  'Invalid authoritative asteroid tag'
                );
                hitDetails = { shooterId: data.shooterId, expiresAt: data.expiresAt };
              }
              let eventOrigin: Position | undefined;
              if ('origin' in data && data.origin !== undefined) {
                const value = data.origin;
                assert(
                  value &&
                    typeof value === 'object' &&
                    'x' in value &&
                    typeof value.x === 'number' &&
                    Number.isFinite(value.x) &&
                    'y' in value &&
                    typeof value.y === 'number' &&
                    Number.isFinite(value.y),
                  'Invalid combat event origin'
                );
                eventOrigin = { x: value.x, y: value.y };
              }
              assert(envelope.type !== 'asteroidDestroy' || asteroidId, 'Destroy event lacks id');
              assert(envelope.type !== 'shockwave' || eventOrigin, 'Shockwave event lacks origin');
              combatWitness.authoritativeEventCounts[envelope.type]++;
              if (authoritativeEvents.length < combatWitness.retainedLimitPerSeries) {
                const observedAtMs = performance.now();
                const position =
                  eventOrigin ??
                  (envelope.type === 'playerDamaged'
                    ? latestAuthoritativeState?.entities.find(
                        (entity) => entity.id === targetPlayerId
                      )?.position
                    : latestAuthoritativeState?.asteroids.find(
                        (asteroid) => asteroid.id === asteroidId
                      )?.position);
                authoritativeEvents.push({
                  type: envelope.type,
                  ...hitDetails,
                  observedAtMs,
                  serverTimestamp:
                    'timestamp' in envelope && typeof envelope.timestamp === 'number'
                      ? envelope.timestamp
                      : null,
                  asteroidId: asteroidId ?? null,
                  position: position ? { ...position } : null,
                  positionSource: eventOrigin
                    ? 'event-origin'
                    : position
                      ? 'latest-snapshot'
                      : 'unknown',
                  viewport: viewportWitness(position, observedAtMs),
                  collabSplit: 'collabSplit' in data && data.collabSplit === true,
                  consumedBy:
                    'consumedBy' in data && data.consumedBy === 'furnace' ? 'furnace' : null,
                });
              } else {
                combatWitness.omittedAuthoritativeEvents++;
              }
            }
            return;
          }
          assert.equal(
            result.metadata.sequence,
            sequence + 1,
            'Browser snapshot sequence is not contiguous'
          );
          sequence++;
          const state = result.state;
          latestAuthoritativeState = state;
          const regionalSnapshot = regionalWorkload
            ? regionalSnapshotWork(state, result.metadata, measuredPilotId)
            : undefined;
          if (regionalSnapshot) {
            assert(measuredPilotId, 'Regional snapshot has no negotiated browser owner');
            if (measuring && !arranging) {
              largeSnapshots.offer(text, {
                ownerId: measuredPilotId,
                measured: true,
                ...regionalSnapshot,
              });
            }
            regionalDecodedWork.remember(measuredPilotId, regionalSnapshot);
            if (!measuring && !arranging) {
              regionalWork.warmupScanStates += Number(regionalSnapshot.scanning);
              regionalWork.warmupExpandedScanStates += Number(regionalSnapshot.expanded);
            }
          }
          if (measuring && !arranging && regionalWorkload) {
            assert(regionalSnapshot, 'Regional snapshot lost the browser pilot');
            const scanning = regionalSnapshot.scanning;
            regionalWork.snapshotStates++;
            regionalWork[scanning ? 'scanStates' : 'normalStates']++;
            regionalWork.statesWithoutAsteroids += Number(state.asteroids.length === 0);
            regionalWork.minAsteroids =
              regionalWork.snapshotStates === 1
                ? state.asteroids.length
                : Math.min(regionalWork.minAsteroids, state.asteroids.length);
            regionalWork.maxAsteroids = Math.max(regionalWork.maxAsteroids, state.asteroids.length);
            if (regionalSnapshot.expanded) {
              regionalWork.expandedScanStates++;
            }
          }
          const motion = state.entities.find(
            (entity) => entity.id === measuredPilotId
          )?.playerMotion;
          if (measuring && !arranging) {
            const observedAtMs = performance.now();
            for (const collection of ['entities', 'asteroids'] as const) {
              for (const actor of state[collection]) {
                const before = previousHealth?.[collection].get(actor.id);
                if (before === undefined || actor.health >= before) {
                  continue;
                }
                combatWitness.healthDecreaseCounts[collection]++;
                if (healthDecreases.length < combatWitness.retainedLimitPerSeries) {
                  healthDecreases.push({
                    observedAtMs,
                    gameTime: state.gameTime,
                    snapshotSequence: sequence,
                    collection,
                    id: actor.id,
                    before,
                    after: actor.health,
                    position: { ...actor.position },
                    viewport: viewportWitness(actor.position, observedAtMs),
                  });
                } else {
                  combatWitness.omittedHealthDecreases++;
                }
              }
            }
            previousHealth = {
              entities: new Map(state.entities.map((entity) => [entity.id, entity.health])),
              asteroids: new Map(state.asteroids.map((asteroid) => [asteroid.id, asteroid.health])),
            };
          } else {
            previousHealth = undefined;
          }
          if (!measuring) {
            warmupSnapshotBytes +=
              typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
            warmupSnapshotCount++;
            measurementGameTime = state.gameTime;
            lastMotionAck = motion ? `${motion.epoch}:${motion.ack}` : '';
            return;
          }
          measuredSnapshotBytes +=
            typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
          const arrivedAt = performance.now();
          stateGaps.push({
            from: lastMeasuredStateAt,
            to: arrivedAt,
            durationMs: arrivedAt - lastMeasuredStateAt,
          });
          lastMeasuredStateAt = arrivedAt;
          if (motion && motion.ack > 0 && `${motion.epoch}:${motion.ack}` !== lastMotionAck) {
            acknowledgedMotionStates++;
            lastMotionAck = `${motion.epoch}:${motion.ack}`;
          }
          for (const shot of state.playerProjectiles) {
            if (
              shot.ownerId === measuredPilotId &&
              state.gameTime - shot.age > measurementGameTime
            ) {
              observedProjectiles.add(shot.id);
            }
          }
        } catch (error) {
          errors.push(`Snapshot witness failed: ${String(error)}`);
        }
      });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });
    // tsx injects this helper into serialized callbacks, never into the app build.
    await page.addInitScript(() => {
      Reflect.set(globalThis, '__name', (target: unknown) => target);
    });
    let profileSession: CDPSession | undefined;
    async function stopProfile() {
      if (!profileSession) {
        return;
      }
      const session = profileSession;
      profileSession = undefined;
      const { profile } = await session.send('Profiler.stop');
      assert(values['cpu-profile']);
      await mkdir(dirname(values['cpu-profile']), { recursive: true });
      await writeFile(values['cpu-profile'], JSON.stringify(profile));
      await session.detach();
    }
    const traceRuntime: ActiveTraceSession = { session: undefined, started: false };
    const startTrace = async () => {
      if (!tracePath) {
        return;
      }
      const session = await context.newCDPSession(page);
      traceRuntime.session = session;
      await session.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        streamCompression: 'gzip',
        bufferUsageReportingInterval: 1_000,
        traceConfig: {
          enableSampling: true,
          recordMode: 'recordAsMuchAsPossible',
          traceBufferSizeInKb: TRACE_BUFFER_SIZE_KB,
          includedCategories: TRACE_CATEGORIES.split(','),
        },
      });
      traceRuntime.started = true;
    };
    const stopTrace = createTraceStopper(traceRuntime, tracePath, assignTraceArtifact);
    async function markTraceMeasurementEnd(): Promise<void> {
      if (!traceMeasurementStarted || traceMeasurementEndAttempted || !tracePath) {
        return;
      }
      traceMeasurementEndAttempted = true;
      await page.evaluate(
        ({ end, measure, start }) => {
          performance.mark(end);
          performance.measure(measure, start, end);
        },
        {
          end: TRACE_MEASUREMENT_END_MARK,
          measure: TRACE_MEASUREMENT_MEASURE,
          start: TRACE_MEASUREMENT_START_MARK,
        }
      );
    }
    let touchSession: CDPSession | undefined;
    let touchActive = false;
    let desktopFireTimer: ReturnType<typeof setInterval> | undefined;
    let desktopFirePending: Promise<void> | undefined;
    const desktopFire = {
      periodMs: 250,
      measuredOffered: 0,
      measuredCompleted: 0,
      measuredSkippedSlots: 0,
    };
    function startDesktopFire(): void {
      if (desktopFireTimer !== undefined) {
        return;
      }
      let nextSlot = performance.now() + desktopFire.periodMs;
      desktopFireTimer = setInterval(() => {
        const now = performance.now();
        const missedSlots = Math.max(0, Math.floor((now - nextSlot) / desktopFire.periodMs));
        nextSlot += (missedSlots + 1) * desktopFire.periodMs;
        const measured = measuring;
        if (measured) {
          desktopFire.measuredSkippedSlots += missedSlots;
        }
        if (desktopFirePending) {
          if (measured) {
            desktopFire.measuredSkippedSlots++;
          }
          return;
        }
        if (measured) {
          desktopFire.measuredOffered++;
        }
        desktopFirePending = page.keyboard
          .press('Space')
          .then(() => {
            if (measured) {
              desktopFire.measuredCompleted++;
            }
          })
          .catch((error: unknown) => {
            errors.push(`Desktop combat firing failed: ${String(error)}`);
            clearInterval(desktopFireTimer);
            desktopFireTimer = undefined;
          })
          .finally(() => {
            desktopFirePending = undefined;
          });
      }, desktopFire.periodMs);
    }
    async function stopDesktopFire(): Promise<void> {
      clearInterval(desktopFireTimer);
      desktopFireTimer = undefined;
      await desktopFirePending;
    }
    try {
      const cpuSession =
        values.browser === 'chromium' ? await context.newCDPSession(page) : undefined;
      const webSocketNegotiations: Array<{ url: string; status: number; extensions: string }> = [];
      constraints['webSocketNegotiations'] = webSocketNegotiations;
      constraints['webSocketNegotiationSource'] = cpuSession ? 'cdp' : 'unavailable';
      if (cpuSession) {
        const gameplaySockets = new Map<string, string>();
        cpuSession.on('Network.webSocketCreated', ({ requestId, url }) => {
          if (new URL(url).pathname === '/ws') {
            gameplaySockets.set(requestId, url);
          }
        });
        cpuSession.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
          const url = gameplaySockets.get(requestId);
          if (url) {
            const extensions =
              Object.entries(response.headers).find(
                ([name]) => name.toLowerCase() === 'sec-websocket-extensions'
              )?.[1] ?? '';
            webSocketNegotiations.push({ url, status: response.status, extensions });
          }
        });
        cpuSession.on('Network.webSocketClosed', ({ requestId }) => {
          gameplaySockets.delete(requestId);
        });
        await cpuSession.send('Network.enable');
      }
      function calibrate() {
        return page.evaluate(() => {
          const start = performance.now();
          let result = 0;
          for (let i = 0; i < 20_000_000; i++) {
            result += Math.sqrt(i);
          }
          return { durationMs: performance.now() - start, result };
        });
      }
      // Warm JIT compilation before alternating longer samples. A single short
      // loop confounds timer resolution and scheduler noise with the CPU limit.
      for (let index = 0; index < 3; index++) {
        await calibrate();
      }
      const cpuCalibration: Array<{
        rate: number;
        durationMs: number;
        result: number;
      }> = [];
      constraints['cpuCalibration'] = cpuCalibration;
      for (let pair = 0; pair < 3; pair++) {
        for (const rate of [1, cpuSlowdown]) {
          await cpuSession?.send('Emulation.setCPUThrottlingRate', { rate });
          cpuCalibration.push({ rate, ...(await calibrate()) });
        }
      }
      function calibrationMedian(offset: number) {
        const samples = cpuCalibration.filter((_, index) => index % 2 === offset);
        const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
        const durationMs = durations[1];
        const result = samples[0]?.result;
        assert(durationMs !== undefined && result !== undefined);
        assert(
          samples.every((sample) => sample.result === result),
          'CPU calibration work differs'
        );
        return { durationMs, result };
      }
      const cpuControl = calibrationMedian(0);
      const cpuConstrained = calibrationMedian(1);
      Object.assign(constraints, { cpuControl, cpuConstrained });
      assert(
        cpuControl.result === cpuConstrained.result && cpuControl.durationMs > 0,
        'CPU calibration failed'
      );
      if (cpuSlowdown > 1) {
        assert(
          cpuConstrained.durationMs > cpuControl.durationMs * 1.5,
          'CPU slowdown calibration did not witness constraint'
        );
      }
      const networkProbes: Array<{ route: string; milliseconds: number; bytes: number }> = [];
      const networkRoutes: string[] = [
        healthUrl,
        socketUrl.replace(/^ws:/u, 'http:').replace(/\/ws$/u, '/health'),
      ];
      for (const route of networkRoutes) {
        for (let i = 0; i < 3; i++) {
          const start = performance.now();
          const response: Response = await fetch(route, { signal: AbortSignal.timeout(10_000) });
          assert(response.ok, 'Network calibration failed');
          const body = await response.arrayBuffer();
          networkProbes.push({
            route,
            milliseconds: performance.now() - start,
            bytes: body.byteLength,
          });
        }
      }
      assert(
        new URL(socketUrl).port !== new URL(healthUrl).port,
        'Gameplay run bypasses its owned TCP proxy'
      );
      if (network !== 'clean') {
        const control = networkProbes
          .slice(0, 3)
          .reduce((sum, probe) => sum + probe.milliseconds, 0);
        const impaired = networkProbes.slice(3).reduce((sum, probe) => sum + probe.milliseconds, 0);
        assert(impaired > control * 1.2, 'Matched network probes did not witness impairment');
      }
      Object.assign(constraints, {
        cpuControl,
        cpuConstrained,
        networkProbes,
        profile: networkProfiles[network],
      });
      await page.goto(
        `${origin}/?performance=collect&renderDpr=${values['render-dpr']}&renderGlow=${values['render-glow']}&renderer=${renderer}`,
        { waitUntil: 'load' }
      );
      await page.locator('#start-game').click();
      await page.waitForFunction(
        () =>
          window.gameController?.getNetworkManager().isConnected &&
          window.gameController.getCurrPlayer()?.ship &&
          window.georoidsPerformance &&
          !window.georoidsPerformance.read().pendingJoin,
        undefined,
        { timeout: 10_000 }
      );
      joined = await collectInterval(joinIntervals);
      metadata = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
        const snapshot = window.georoidsPerformance?.read();
        return {
          userAgent: navigator.userAgent,
          dpr: devicePixelRatio,
          css: canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : null,
          effectiveDpr: canvas?.clientWidth ? canvas.width / canvas.clientWidth : null,
          touchPoints: navigator.maxTouchPoints,
          backing: canvas ? { width: canvas.width, height: canvas.height } : null,
          visibility: document.visibilityState,
          canvasVisible: canvas?.checkVisibility() ?? false,
          clientReleaseId: snapshot?.clientReleaseId,
          serverReleaseId: snapshot?.serverReleaseId,
          rendererObservation: snapshot && 'renderer' in snapshot ? snapshot.renderer : null,
        };
      });
      assert.equal(metadata['visibility'], 'visible', 'Admitted page is hidden');
      assert.equal(metadata['canvasVisible'], true, 'Admitted game canvas is hidden');
      assert.equal(metadata['dpr'], dpr, 'Browser device DPR differs from request');
      const backing = metadata['backing'];
      const css = metadata['css'];
      assert(
        backing &&
          typeof backing === 'object' &&
          'width' in backing &&
          'height' in backing &&
          css &&
          typeof css === 'object' &&
          'width' in css &&
          typeof css.width === 'number' &&
          'height' in css &&
          typeof css.height === 'number'
      );
      const effectiveDpr =
        values['render-dpr'] === 'native' ? dpr : Math.min(dpr, Number(values['render-dpr']));
      assert.equal(
        backing.width,
        Math.round(css.width * effectiveDpr),
        'Canvas backing width ignores quality request'
      );
      assert.equal(
        backing.height,
        Math.round(css.height * effectiveDpr),
        'Canvas backing height ignores quality request'
      );
      assert(
        Math.abs(Number(metadata['effectiveDpr']) - effectiveDpr) <= 1 / css.width,
        'Effective rendering DPR differs'
      );
      assert(
        sockets.length > 0 &&
          sockets.every((endpoint) => {
            const actual = new URL(endpoint);
            const expected = new URL(socketUrl);
            return actual.host === expected.host && actual.pathname === expected.pathname;
          }),
        'Browser gameplay did not use owned endpoint'
      );
      const protocolPeerFail = (error: unknown) => {
        errors.push(String(error));
      };
      const protocolPeerOptions = (_index: number) => ({
        url: new URL(`${socketUrl}?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`),
        measuring: () => measuring,
        fail: protocolPeerFail,
        deliveryBudget: () => delivery,
        repeatMeasuredPings: false,
        ...(regionalWorkload ? { naturalSpawn: true } : {}),
      });
      for (let index = 0; index < (combatWorkload ? 4 : 0); index++) {
        await delay(1500);
        const peer = new Pilot(index, protocolPeerOptions(index));
        peers.push(peer);
        const deadline = performance.now() + 10_000;
        while (!peer.state) {
          if (performance.now() >= deadline) {
            break;
          }
          await delay(25);
        }
        assert(peer.state, 'Protocol peer failed admission');
      }
      let preparedJoins: number[] = [];
      async function arrange(target: Interval[]) {
        previousHealth = undefined;
        // Stop starting new attempts after 30 seconds. In-flight control and
        // menu operations retain their own bounded deadlines.
        const deadline = performance.now() + 30_000;
        try {
          while (performance.now() < deadline) {
            arranging = true;
            const id = await page.evaluate(() => {
              const controller = window.gameController;
              const player = controller?.getCurrPlayer();
              return player &&
                player.ship.health > 0 &&
                !player.ship.exploding &&
                controller?.getNetworkManager().isConnected &&
                window.georoidsPerformance &&
                !window.georoidsPerformance.read().pendingJoin
                ? player.id
                : undefined;
            });
            if (!id) {
              arranging = false;
              await recoverBrowser(target);
              continue;
            }
            if (regionalWorkload) {
              assert.equal(id, measuredPilotId, 'Prepared browser differs from its joined owner');
            } else {
              measuredPilotId = id;
            }
            const fixture = await prepareFixture(join(ownedSessionPath, 'fixture.sock'), {
              scenario: fixtureScenario,
              participants: [id, ...peers.map((peer) => peer.id)],
            });
            if (fixture.kind === 'pending') {
              // No world mutation occurred. Let missing participants rejoin.
              arranging = false;
              if (fixture.missing.includes(id)) {
                await recoverBrowser(target);
              } else {
                for (const peer of peers) {
                  if (fixture.missing.includes(peer.id)) {
                    peer.drive(0);
                  }
                }
                await delay(25);
              }
              continue;
            }
            // Keep every prepared attempt, including one invalidated by a queued leave.
            fixtures.push(fixture);
            if (!regionalWorkload) {
              assert.equal(
                fixture.hash,
                fixtures[0]?.hash,
                'Rejoined fixture differs from initial world'
              );
            }
            const own = fixture.baselines.find((baseline) => baseline.id === id);
            assert(own, 'Missing measured baseline');
            const joins = peers.map((peer) => peer.gameJoins);
            const baselineDeadline = Math.min(deadline, performance.now() + 15_000);
            let browserDeparted = false;
            let peerDeparted = false;
            while (performance.now() < baselineDeadline) {
              const witness = await page.evaluate((playerId) => {
                const interval = window.georoidsPerformance?.read();
                const player = window.gameController?.getCurrPlayer();
                return {
                  snapshotSession: interval?.snapshotSession ?? null,
                  departed:
                    player?.id !== playerId ||
                    (player?.ship.health ?? 0) <= 0 ||
                    !window.gameController?.getNetworkManager().isConnected ||
                    !interval ||
                    interval.pendingJoin,
                  observation: {
                    lastKeyframeSequence: interval?.lastKeyframeSequence ?? null,
                    lastSnapshotGameTime: interval?.lastSnapshot?.gameTime ?? null,
                    motionEpoch: player?.ship.playerMotion?.epoch ?? null,
                  },
                };
              }, id);
              browserDeparted = witness.departed;
              peerDeparted = peers.some(
                (peer, index) => !peer.state || peer.gameJoins !== joins[index]
              );
              if (browserDeparted || peerDeparted) {
                break;
              }
              const peersReady = peers.every((peer) => {
                const baseline = fixture.baselines.find((row) => row.id === peer.id);
                assert(baseline, 'Missing peer baseline');
                const player = peer.state?.entities.find((entity) => entity.id === peer.id);
                return observesPreparedFixture(
                  {
                    sequence: baseline.sequence,
                    gameTime: fixture.gameTime,
                    motionEpoch: baseline.motionEpoch,
                    requireExactMotionEpoch: regionalWorkload,
                  },
                  {
                    lastKeyframeSequence: peer.lastKeyframeSequence,
                    lastSnapshotGameTime: peer.state?.gameTime ?? null,
                    motionEpoch: player?.playerMotion?.epoch ?? null,
                  }
                );
              });
              if (
                observesPreparedFixture(
                  {
                    sequence: own.sequence,
                    gameTime: fixture.gameTime,
                    motionEpoch: own.motionEpoch,
                    requireExactMotionEpoch: regionalWorkload,
                  },
                  witness.observation
                ) &&
                peersReady
              ) {
                preparedJoins = joins;
                if (regionalWorkload) {
                  assert(
                    witness.snapshotSession !== null &&
                      Number.isSafeInteger(witness.snapshotSession),
                    'Missing regional browser session'
                  );
                  preparedBrowserSession = witness.snapshotSession;
                }
                return;
              }
              await delay(25);
            }
            assert(
              browserDeparted || peerDeparted,
              'Participants did not observe prepared baseline'
            );
            arranging = false;
            if (browserDeparted) {
              await recoverBrowser(target);
            }
            for (const peer of peers) {
              if (!peer.state) {
                peer.drive(0);
              }
            }
          }
          assert.fail('Fixture participants did not recover');
        } finally {
          arranging = false;
        }
      }
      await arrange(warmupIntervals);
      let peerTick = 0;
      peerTimer = setInterval(() => {
        if (arranging) {
          return;
        }
        for (const peer of peers) {
          try {
            peer.drive(peerTick);
          } catch (error) {
            errors.push(String(error));
          }
        }
        peerTick++;
      }, 50);
      // Real input and real animation frames. No manual updateGame or source-module imports.
      async function releaseInput({ stopFiring = true } = {}) {
        if (stopFiring) {
          await stopDesktopFire();
        }
        if (touchActive) {
          assert(touchSession, 'Active touch must have an owning session');
          await touchSession.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
          });
          touchActive = false;
        }
        if (!scenario.hasTouch || values.browser !== 'chromium') {
          await page.keyboard.up('ArrowUp');
          await page.keyboard.up('ArrowLeft');
          if (stopFiring) {
            await page.keyboard.up('Space');
          }
        }
      }
      function planRegionalScan(uiReady: boolean, uiLabel: string | null = null) {
        const own = latestAuthoritativeState?.entities.find(
          (entity) => entity.id === measuredPilotId
        );
        const cooldownFrames =
          own?.kitId === 'scout' &&
          (own.scoutUtility ?? 'mineral_scan') === 'mineral_scan' &&
          own.health > 0 &&
          !own.exploding &&
          !own.furnaceTransit &&
          !onDarkFurnaceFootprint(own.position, (id) =>
            Boolean(latestAuthoritativeState?.civicModules?.some((module) => module.id === id))
          )
            ? own.abilityCooldownFrames
            : undefined;
        const attempt = {
          step: inputSteps,
          measured: measuring,
          decision: regionalScanSchedule.plan(inputSteps, measuring, uiReady, cooldownFrames),
          uiReady,
          authoritativeCooldownFrames: cooldownFrames,
          authoritativeGameTime: latestAuthoritativeState?.gameTime,
          uiLabel,
          dispatched: false,
        };
        assert(regionalScanEvidence.attempts.length < 4096, 'Regional scan input bound exceeded');
        regionalScanEvidence.attempts.push(attempt);
        return attempt;
      }
      async function applyInput() {
        const action = {
          startedAt: performance.now(),
          completedAt: undefined as number | undefined,
          measured: measuring,
        };
        inputActions.push(action);
        inputSteps++;
        await releaseInput({ stopFiring: false });
        if (scenario.hasTouch && values.browser === 'chromium') {
          touchSession ??= await context.newCDPSession(page);
          const playfield = await page.locator('#gameCanvas').boundingBox();
          const extra = regionalWorkload || inputSteps % 20 === 0 ? '#touch-ability' : undefined;
          const uiLabel = regionalWorkload
            ? await page.locator('#touch-ability').textContent()
            : null;
          const extraBox =
            extra &&
            (!regionalWorkload || uiLabel === 'SCAN') &&
            (await page.locator(extra).getAttribute('aria-disabled')) !== 'true'
              ? await page.locator(extra).boundingBox()
              : null;
          const scanAttempt = regionalWorkload
            ? planRegionalScan(extraBox !== null, uiLabel)
            : undefined;
          const dispatchAbility = scanAttempt ? scanAttempt.decision === 'dispatch' : true;
          assert(playfield, 'Playfield absent');
          const steerX = playfield.x + playfield.width * (inputSteps % 2 ? 0.8 : 0.2);
          const fireX = playfield.x + playfield.width * (inputSteps % 2 ? 0.2 : 0.8);
          const touchY = playfield.y + playfield.height * 0.5;
          await touchSession.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [
              { x: steerX, y: touchY, id: 1 },
              { x: fireX, y: touchY, id: 2 },
              ...(extraBox && dispatchAbility
                ? [
                    {
                      x: extraBox.x + extraBox.width / 2,
                      y: extraBox.y + extraBox.height / 2,
                      id: 3,
                    },
                  ]
                : []),
            ],
          });
          if (scanAttempt && extraBox && dispatchAbility) {
            scanAttempt.dispatched = true;
            regionalScanSchedule.dispatched();
          }
          touchActive = true;
        } else {
          await page.keyboard.down('ArrowUp');
          await page.keyboard.down('ArrowLeft');
          if (combatWorkload) {
            startDesktopFire();
          } else {
            await page.keyboard.press('Space');
          }
          const scanAttempt = regionalWorkload
            ? planRegionalScan(
                await page.evaluate(() => {
                  const ship = window.gameController?.getCurrPlayer()?.ship;
                  return Boolean(
                    ship &&
                      ship.health > 0 &&
                      !ship.exploding &&
                      !ship.furnaceTransit &&
                      ship.abilityCooldownFrames <= 0
                  );
                })
              )
            : undefined;
          if (scanAttempt ? scanAttempt.decision === 'dispatch' : inputSteps % 20 === 0) {
            await page.keyboard.press('e');
            if (scanAttempt) {
              scanAttempt.dispatched = true;
              regionalScanSchedule.dispatched();
            }
          }
          if (inputSteps % 40 === 0) {
            await page.keyboard.press('f');
          }
        }
        action.completedAt = performance.now();
      }
      async function recoverBrowser(target: Interval[]) {
        const restartAt = performance.now();
        await releaseInput();
        await page.waitForFunction(
          () => {
            const player = window.gameController?.getCurrPlayer();
            return player && player.ship.health > 0 && !player.ship.exploding;
          },
          undefined,
          { timeout: 15000 }
        );
        await page.waitForFunction(
          () =>
            window.gameController?.getNetworkManager().isConnected &&
            window.georoidsPerformance &&
            !window.georoidsPerformance.read().pendingJoin,
          undefined,
          { timeout: 10000 }
        );
        restarts.push({
          kind: 'browser-respawn',
          startedAt: restartAt,
          durationMs: performance.now() - restartAt,
        });
        await collectInterval(target);
      }
      function correlateAppliedRegionalSnapshots(interval: Interval, measured: boolean): void {
        if (regionalWorkload) {
          assert.equal(
            interval.appliedSnapshots.omittedSamples,
            0,
            'Applied regional receipts were omitted'
          );
          assert.equal(interval.appliedSnapshots.count, interval.appliedSnapshots.values.length);
          for (const applied of interval.appliedSnapshots.values) {
            assert(
              Number.isFinite(applied.appliedAt) && applied.appliedAt >= 0,
              'Missing browser application clock'
            );
            const appliedDuringMeasurement =
              measured &&
              browserMeasurementStartedAt !== undefined &&
              applied.appliedAt >= browserMeasurementStartedAt;
            const decoded = regionalDecodedWork.match(applied);
            const work = requireAppliedRegionalWork(
              decoded,
              applied,
              measuredPilotId,
              appliedDuringMeasurement ? preparedBrowserSession : undefined
            );
            if (previousRegionalApplication) {
              assert(
                applied.session >= previousRegionalApplication.session,
                'Applied regional session regressed'
              );
              assert(
                applied.gameTime >= previousRegionalApplication.gameTime &&
                  applied.serverTime !== undefined &&
                  previousRegionalApplication.serverTime !== undefined &&
                  applied.serverTime >= previousRegionalApplication.serverTime,
                'Applied regional world clock regressed'
              );
              if (applied.session === previousRegionalApplication.session) {
                assert(
                  applied.sequence > previousRegionalApplication.sequence,
                  'Applied regional sequence did not advance'
                );
              }
            }
            previousRegionalApplication = applied;
            assert(
              regionalScanEvidence.applied.length < regionalScanEvidence.appliedRetainedLimit,
              'Regional applied work bound exceeded'
            );
            regionalScanEvidence.applied.push({
              measured: appliedDuringMeasurement,
              session: applied.session,
              work,
            });
            if (appliedDuringMeasurement) {
              regionalWork.appliedNormalStates += Number(!work.scanning);
              regionalWork.appliedScanStates += Number(work.scanning);
              regionalWork.appliedExpandedScanStates += Number(work.expanded);
            }
          }
        }
      }
      async function collectInterval(target: Interval[]) {
        const collectionStartedAt = performance.now();
        const interval = await drain(page);
        target.push(interval);
        correlateAppliedRegionalSnapshots(interval, target === intervals);
        const observations: FreshnessObservation[] = [
          {
            id: 'browser',
            session: interval.snapshotSession,
            pendingRecovery: interval.pendingJoin || interval.pendingRecovery,
            applied: interval.lastSnapshot,
          },
          ...peers.map((peer) => ({
            id: peer.id,
            session: peer.gameJoins,
            pendingRecovery: !peer.joined || !peer.state,
            applied: peer.lastSnapshot,
          })),
        ];
        const appliedObservedAt = performance.now();
        const phase =
          restarts.length !== lastFreshnessRestartCount ||
          observations.some((client) => client.pendingRecovery)
            ? 'recovery'
            : 'steady';
        lastFreshnessRestartCount = restarts.length;
        const sample: (typeof freshnessSamples)[number] = {
          index: freshnessAttempts++,
          measured: target === intervals,
          phase,
          collectionStartedAt,
          appliedObservedAt,
          queryStartedAt: performance.now(),
          queryEndedAt: 0,
          queryDurationMs: 0,
          clock: null,
          observations,
          clients: [],
          failure: null,
          probeFailure: null,
        };
        if (freshnessSamples.length >= 4096) {
          omittedFreshnessSamples++;
          throw new Error('Applied freshness sample bound exceeded');
        }
        freshnessSamples.push(sample);
        try {
          sample.clock = await readSimulationClock(join(ownedSessionPath, 'fixture.sock'));
        } catch (error) {
          sample.failure = String(error);
          sample.probeFailure = {
            error: serializeBenchmarkError(error),
            response: error instanceof SimulationClockProbeError ? error.response : null,
          };
          throw error;
        } finally {
          sample.queryEndedAt = performance.now();
          sample.queryDurationMs = sample.queryEndedAt - sample.queryStartedAt;
        }
        const clock = sample.clock;
        assert(clock, 'Missing independent simulation clock');
        if (
          previousSimulationClock &&
          (clock.gameTime < previousSimulationClock.gameTime ||
            clock.serverTime < previousSimulationClock.serverTime)
        ) {
          sample.failure = 'Independent simulation clock regressed';
          throw new Error(sample.failure);
        }
        previousSimulationClock = clock;
        sample.clients = observations.map((observation) =>
          appliedFreshness(clock, observation, previousFreshness.get(observation.id), phase)
        );
        for (const client of sample.clients) {
          if (client.kind === 'invalid') {
            sample.failure = `${client.observation.id}: ${client.reason}`;
            throw new Error(sample.failure);
          }
          previousFreshness.set(client.observation.id, client.observation);
          if (target === intervals) {
            performanceBudget.observe(
              `${client.observation.id}.serverToAppliedMs`,
              client.serverToAppliedMs,
              delivery.maximumStateGapMs
            );
          }
        }
        if (
          regionalWorkload &&
          target === intervals &&
          interval.snapshotSession !== preparedBrowserSession
        ) {
          sample.failure = 'Regional browser rejoined during measurement';
          throw new Error(sample.failure);
        }
        if (target === intervals) {
          requireMeasuredRenderer(interval);
        }
        if (regionalWorkload) {
          const regionalSample: (typeof regionalStatusSamples)[number] = {
            measured: target === intervals,
            startedAt: performance.now(),
            endedAt: 0,
            status: null,
            failure: null,
            freshnessSampleIndex: sample.index,
            peerAsteroidRows: peers.map((peer) => ({
              id: peer.id,
              rows: peer.state?.asteroids.length ?? 0,
            })),
          };
          assert(regionalStatusSamples.length < 4096, 'Regional status sample bound exceeded');
          regionalStatusSamples.push(regionalSample);
          try {
            regionalSample.status = await readRegionalStatus(
              join(ownedSessionPath, 'fixture.sock')
            );
            assert(
              regionalSample.status.activeSectors > 0 && regionalSample.status.asteroids > 0,
              'Natural regional field became empty'
            );
            if (target === intervals) {
              assert.equal(regionalSample.status.players, 5, 'Regional combat lost a participant');
              assert(
                regionalSample.peerAsteroidRows.every((peer) => peer.rows > 0),
                'Regional peer has no nearby asteroid rows'
              );
            }
          } catch (error) {
            regionalSample.failure = errorRecord(error);
            throw error;
          } finally {
            regionalSample.endedAt = performance.now();
          }
        }
        return interval;
      }
      async function observe(duration: number, target: Interval[]) {
        const until = performance.now() + duration;
        let nextProgressAt = performance.now() + 30_000;
        let nextSlot = performance.now();
        while (performance.now() < until) {
          const wakeAt = Math.min(nextSlot, until);
          while (performance.now() < wakeAt) {
            await delay(Math.max(1, Math.ceil(wakeAt - performance.now())));
          }
          const slotStarted = performance.now();
          if (slotStarted >= until) {
            break;
          }
          const missedSlots = Math.max(0, Math.floor((slotStarted - nextSlot) / 1000));
          inputSchedule.push({
            scheduledAt: nextSlot,
            startedAt: slotStarted,
            missedSlots,
            measured: target === intervals,
          });
          // Keep offered work on the clock, independent of the previous frame's
          // observation cost. Missed slots are reported, never replayed in bursts.
          nextSlot += (missedSlots + 1) * 1000;
          const peerJoinsChanged = (expectedJoins: number[]) =>
            peers.some((peer, index) => peer.gameJoins !== expectedJoins[index]);
          const awaitingPeerState = () => peers.some((peer) => !peer.state);
          if (peerJoinsChanged(preparedJoins)) {
            assert(
              workload !== 'dense-combat' && !regionalWorkload,
              'Live-field combat lost a peer; refusing to replace or recapture its field'
            );
            const restartAt = performance.now();
            await releaseInput();
            const deadline = performance.now() + 10_000;
            while (awaitingPeerState()) {
              if (performance.now() >= deadline) {
                break;
              }
              await delay(25);
            }
            assert(
              peers.every((peer) => peer.state),
              'Peer rejoin timed out'
            );
            await arrange(target);
            restarts.push({
              kind: 'peer-rejoin',
              startedAt: restartAt,
              durationMs: performance.now() - restartAt,
            });
          }
          await applyInput();
          const interval = await collectInterval(target);
          const camera = await page.evaluate(() => {
            const player = window.gameController?.getCurrPlayer();
            const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
            return player?.ship && canvas
              ? {
                  position: player.ship.position,
                  width: canvas.clientWidth,
                  height: canvas.clientHeight,
                }
              : null;
          });
          sampledCamera = camera ? { ...camera, observedAtMs: performance.now() } : undefined;
          if (camera && latestAuthoritativeState) {
            const state = latestAuthoritativeState;
            const observedPilotId = measuredPilotId;
            const visible = (position: { x: number; y: number }) =>
              Math.abs(position.x - camera.position.x) * PLAYFIELD_CLOSE_SCALE <=
                camera.width / 2 &&
              Math.abs(position.y - camera.position.y) * PLAYFIELD_CLOSE_SCALE <= camera.height / 2;
            const populations = {
              players: state.entities,
              asteroids: state.asteroids,
              loot: state.loot,
              pickups: state.satellitePickups,
              projectiles: state.playerProjectiles,
              ...(regionalWorkload
                ? {
                    mapAssets: state.mapAssets,
                    spiders: state.spiderField?.spiders ?? [],
                    nests: state.spiderField?.nests ?? [],
                  }
                : {}),
            };
            populationSamples.push({
              gameTime: state.gameTime,
              measured: target === intervals,
              ...(regionalWorkload
                ? {
                    abilityActiveFrames:
                      state.entities.find((entity) => entity.id === observedPilotId)
                        ?.abilityActiveFrames ?? 0,
                  }
                : {}),
              counts: Object.fromEntries(
                Object.entries(populations).map(([kind, entities]) => [
                  kind,
                  {
                    total: entities.length,
                    visibleCenters: entities.filter((entity) => visible(entity.position)).length,
                  },
                ])
              ),
            });
          }
          for (const name of [
            'invalidSamples',
            'messageFailures',
            'joinFailures',
            'frameFailures',
            'recoveryFailures',
          ]) {
            assert.equal(interval.counters[name] ?? 0, 0, `Client recorded ${name}`);
          }
          assert(
            Object.values(interval.metrics).every((metric) => metric.omittedSamples === 0),
            'Raw samples omitted'
          );
          const frames = Object.entries(interval.metrics)
            .filter(([name]) => name.endsWith('.frameCpuMs'))
            .reduce((sum, [, metric]) => sum + metric.count, 0);
          assert(
            frames > 0 || interval.durationMs < 100,
            'No active game frames during observation'
          );
          const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
          assert(response.ok, 'Server health failed');
          const healthSample: unknown = await response.json();
          validateHealth(healthSample);
          health.push({ measured: target === intervals, data: healthSample });
          if (healthSample && typeof healthSample === 'object' && 'metrics' in healthSample) {
            const metrics = healthSample.metrics;
            if (
              metrics &&
              typeof metrics === 'object' &&
              'closedWindows' in metrics &&
              Array.isArray(metrics.closedWindows)
            ) {
              for (const sample of metrics.closedWindows) {
                if (
                  sample &&
                  typeof sample === 'object' &&
                  'window' in sample &&
                  sample.window &&
                  typeof sample.window === 'object' &&
                  'id' in sample.window &&
                  typeof sample.window.id === 'string' &&
                  !closedWindowIds.has(sample.window.id)
                ) {
                  closedWindowIds.add(sample.window.id);
                  finalizedHealth.push(sample);
                }
              }
            }
          }
          if (performance.now() >= nextProgressAt) {
            process.stdout.write(
              `${scenario.name} ${target === intervals ? 'measurement' : 'warmup'}: ${target.length} intervals, ${restarts.length} game rejoins\n`
            );
            nextProgressAt = performance.now() + 30_000;
          }
        }
        await collectInterval(target);
      }
      await observe(warmup * 1000, warmupIntervals);
      assert(warmupSnapshotCount > 0, 'No snapshots to size transport workload');
      delivery = deliveryBudget(network, warmupSnapshotBytes / warmupSnapshotCount);
      constraints['deliveryBudget'] = delivery;
      const serverBoundary = await finalizeServerWindow(join(sessionPath, 'fixture.sock'));
      await startTrace();
      if (values['cpu-profile']) {
        profileSession = await context.newCDPSession(page);
        await profileSession.send('Profiler.enable');
        await profileSession.send('Profiler.start');
        profileRecorded = true;
      }
      const startBoundaryFailures = await captureMeasurementBoundary('start');
      if (startBoundaryFailures.length > 0) {
        throw new AggregateError(startBoundaryFailures, 'Measurement start probes failed');
      }
      assert(proxyTransport.start, 'Missing live proxy measurement start');
      assert.equal(
        proxyTransport.start.profile,
        network,
        'Proxy profile differs from requested lane'
      );
      assert(serverProcessCpu.start, 'Missing server process CPU measurement start');
      assert.equal(
        serverProcessCpu.start.compression,
        compression.mode,
        'Server compression differs from requested experiment'
      );
      // Drain all setup work and capture the browser boundary atomically, so
      // warmup/join decode samples cannot satisfy measured timing requirements.
      const measurementBoundary = await page.evaluate(() => {
        const recorder = window.georoidsPerformance;
        if (!recorder) {
          throw new Error('Production performance recorder missing');
        }
        recorder.claimDrain('benchmark');
        const interval = recorder.read(true, 'benchmark');
        return { interval, startedAt: performance.now() };
      });
      warmupIntervals.push(measurementBoundary.interval);
      measurementSetupIntervals.push(measurementBoundary.interval);
      correlateAppliedRegionalSnapshots(measurementBoundary.interval, false);
      for (const name of [
        'invalidSamples',
        'messageFailures',
        'joinFailures',
        'frameFailures',
        'recoveryFailures',
      ]) {
        assert.equal(
          measurementBoundary.interval.counters[name] ?? 0,
          0,
          `Client setup recorded ${name}`
        );
      }
      assert(
        Object.values(measurementBoundary.interval.metrics).every(
          (metric) => metric.omittedSamples === 0
        ),
        'Setup raw samples omitted'
      );
      browserMeasurementStartedAt = measurementBoundary.startedAt;
      constraints['browserMeasurementStartedAt'] = browserMeasurementStartedAt;
      measuring = true;
      for (const peer of peers) {
        peer.beginMeasurement(performance.now());
      }
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      stateMeasuredStarted = started;
      lastMeasuredStateAt = started;
      if (tracePath) {
        await page.evaluate((mark) => performance.mark(mark), TRACE_MEASUREMENT_START_MARK);
        traceMeasurementStarted = true;
      }
      let observationFailure: { error: unknown } | undefined;
      try {
        await observe(seconds * 1000, intervals);
      } catch (error) {
        observationFailure = { error };
      }
      const stateMeasuredEnded = performance.now();
      measurementStoppedAt = stateMeasuredEnded;
      measuring = false;
      // Capture actual partial windows on observation failure before stopping
      // inputs, profiling, tail windows or participants. Never substitute zeroes.
      const endBoundaryFailures = await captureMeasurementBoundary('end');
      if (proxyTransport.start && proxyTransport.end) {
        try {
          proxyTransport.measurement = measureProxyTransport({
            start: proxyTransport.start,
            end: proxyTransport.end,
            profile: network,
          });
        } catch (error) {
          endBoundaryFailures.push(error);
        }
      }
      if (serverProcessCpu.start && serverProcessCpu.end) {
        try {
          serverProcessCpu.measurement = measureServerProcessCpu(
            serverProcessCpu.start,
            serverProcessCpu.end
          );
        } catch (error) {
          endBoundaryFailures.push(error);
        }
      }
      if (observationFailure) {
        if (endBoundaryFailures.length > 0) {
          throw new AggregateError(
            [observationFailure.error, ...endBoundaryFailures],
            'Gameplay observation and measurement boundary failed'
          );
        }
        throw observationFailure.error;
      }
      if (endBoundaryFailures.length > 0) {
        throw new AggregateError(endBoundaryFailures, 'Measurement end probes failed');
      }
      assert(
        proxyTransport.measurement && serverProcessCpu.measurement,
        'Incomplete measurement boundaries'
      );
      await stopDesktopFire();
      clearInterval(peerTimer);
      for (const peer of peers) {
        peer.stopMeasurement();
      }
      await markTraceMeasurementEnd();
      await stopProfile();
      await stopTrace();
      await saveTraceBundles();
      const durationMs = stateMeasuredEnded - started;
      const stateTailGapMs = stateMeasuredEnded - lastMeasuredStateAt;
      const completeStateGaps = [
        ...stateGaps,
        { from: lastMeasuredStateAt, to: stateMeasuredEnded, durationMs: stateTailGapMs },
      ];
      assert(stateGaps.length > 0 && durationMs > 0, 'Missing browser authoritative delivery');
      performanceBudget.observe(
        'browser.stateRateHz',
        (stateGaps.length * 1000) / durationMs,
        Math.max(0, delivery.minimumStateHz - 2000 / durationMs),
        'minimum'
      );
      for (const gap of completeStateGaps) {
        const rejoin = restarts.some(
          (restart) =>
            gap.to >= restart.startedAt && gap.from <= restart.startedAt + restart.durationMs
        );
        performanceBudget.observe(
          rejoin ? 'browser.rejoinGapMs' : 'browser.stateGapMs',
          gap.durationMs,
          rejoin ? delivery.maximumRejoinMs : delivery.maximumStateGapMs
        );
      }
      performanceBudget.observe(
        'browser.finalStateAgeMs',
        stateTailGapMs,
        delivery.maximumStateGapMs
      );
      for (const peer of peers) {
        peer.stopMeasurement();
        peer.validateCompletion();
        peer.completedScenario = true;
      }
      measuring = false;
      const serverTail = await finalizeServerWindow(join(sessionPath, 'fixture.sock'));
      const tailWindows =
        'closedWindows' in serverTail.summary && Array.isArray(serverTail.summary.closedWindows)
          ? serverTail.summary.closedWindows
          : [];
      for (const sample of [...tailWindows, serverTail.summary]) {
        assert(
          sample &&
            typeof sample === 'object' &&
            'window' in sample &&
            sample.window &&
            typeof sample.window === 'object' &&
            'id' in sample.window &&
            typeof sample.window.id === 'string'
        );
        if (!closedWindowIds.has(sample.window.id)) {
          closedWindowIds.add(sample.window.id);
          finalizedHealth.push(sample);
        }
      }
      const measuredServerWindows = finalizedHealth.filter((sample) => {
        assert(sample && typeof sample === 'object' && 'window' in sample);
        const window = sample.window;
        assert(
          window &&
            typeof window === 'object' &&
            'finalized' in window &&
            window.finalized === true &&
            'startedAt' in window &&
            typeof window.startedAt === 'string' &&
            'endedAt' in window &&
            typeof window.endedAt === 'string'
        );
        return (
          Date.parse(window.startedAt) >= Date.parse(serverBoundary.endedAt) &&
          Date.parse(window.endedAt) <= Date.parse(serverTail.endedAt)
        );
      });
      assert(measuredServerWindows.length > 0, 'No finalized measurement server windows');
      const firstServerWindow = measuredServerWindows[0];
      assert(
        firstServerWindow && typeof firstServerWindow === 'object' && 'window' in firstServerWindow
      );
      const firstWindow = firstServerWindow.window;
      assert(
        firstWindow &&
          typeof firstWindow === 'object' &&
          'startedAt' in firstWindow &&
          typeof firstWindow.startedAt === 'string'
      );
      assert(
        Date.parse(firstWindow.startedAt) - Date.parse(serverBoundary.endedAt) < 10,
        'Finalized server coverage starts late'
      );
      let previousWindow = Number(serverBoundary.id.split(':').at(-1));
      const processPrefix = serverBoundary.id.slice(0, serverBoundary.id.lastIndexOf(':'));
      for (const sample of measuredServerWindows) {
        assert(
          sample &&
            typeof sample === 'object' &&
            'window' in sample &&
            sample.window &&
            typeof sample.window === 'object' &&
            'id' in sample.window &&
            typeof sample.window.id === 'string'
        );
        assert.equal(
          sample.window.id,
          `${processPrefix}:${previousWindow + 1}`,
          'Finalized server windows have a coverage gap'
        );
        previousWindow++;
      }
      assert.equal(
        `${processPrefix}:${previousWindow}`,
        serverTail.id,
        'Finalized server tail absent'
      );
      const generatorCpu = process.cpuUsage(cpuStart);
      if (regionalWorkload) {
        regionalFinalManifestAttempted = true;
        regionalFinalManifest = await readRegionalManifest(join(ownedSessionPath, 'fixture.sock'));
      }
      const measuredFrames = intervals.reduce(
        (sum, interval) =>
          sum +
          (interval.metrics['play.frameCpuMs']?.count ?? 0) +
          (interval.metrics['respawn.frameCpuMs']?.count ?? 0),
        0
      );
      assert(measuredFrames > 0, 'No real game frames recorded');
      assert(acknowledgedMotionStates > 0, 'No authoritative motion acknowledgments');
      assert(observedProjectiles.size > 0, 'No authoritative shots born during measurement');
      if (regionalWorkload) {
        assert(
          regionalWork.snapshotStates > 0 &&
            regionalWork.normalStates > 0 &&
            regionalWork.appliedNormalStates > 0,
          'No natural normal-view snapshots measured'
        );
        assert(regionalWork.minAsteroids > 0, 'Natural snapshot contained no nearby asteroids');
        if (seconds >= 30) {
          assert(
            regionalScanEvidence.requests.some((request) => request.measured) &&
              regionalScanEvidence.accepted.some(
                (event) => event.measured && (event.abilityActiveFrames ?? 0) > 0
              ),
            'No measured natural scan request and authoritative acceptance observed'
          );
          assert(
            regionalWork.scanStates > 0 &&
              regionalWork.expandedScanStates > 0 &&
              regionalWork.appliedScanStates > 0 &&
              regionalWork.appliedExpandedScanStates > 0,
            'No accepted natural scan with expanded asteroid rows measured'
          );
        }
      }
      if (seconds >= 300) {
        assert(inputSteps >= 300, 'Insufficient distinct input steps');
      }
      // File totals/peaks are whole-session diagnostics. Qualification uses the
      // live, monotonic proxyTransport window captured above in every lane.
      const proxyStats: unknown = JSON.parse(
        await readFile(join(sessionPath, 'proxy-stats.json'), 'utf8')
      );
      assert(
        proxyStats &&
          typeof proxyStats === 'object' &&
          'bytesUp' in proxyStats &&
          typeof proxyStats.bytesUp === 'number' &&
          proxyStats.bytesUp > 0 &&
          'bytesDown' in proxyStats &&
          typeof proxyStats.bytesDown === 'number' &&
          proxyStats.bytesDown > 0,
        'No whole-session proxy traffic witnessed'
      );
      assert(
        'failures' in proxyStats && proxyStats.failures === 0,
        'Proxy recorded whole-session transport failures'
      );
      assert(
        intervals.some((interval) =>
          Object.keys(interval.metrics).some((name) => name.endsWith('.applyMs'))
        ),
        'No authoritative state application measured'
      );
      assert(
        intervals.every((interval) =>
          Object.values(interval.metrics).every((metric) => metric.omittedSamples === 0)
        ),
        'Raw samples were omitted'
      );
      await mkdir(dirname(values.output), { recursive: true });
      if (cpuSession) {
        assert(
          webSocketNegotiations.some((handshake) => handshake.status === 101),
          'No successful gameplay WebSocket negotiation recorded'
        );
        for (const handshake of webSocketNegotiations.filter((entry) => entry.status === 101)) {
          requireNegotiatedCompression(compression.mode, handshake.extensions);
        }
        constraints['compressionNegotiationVerified'] = true;
      } else {
        assert.equal(
          compression.mode,
          'none',
          'Compression candidate needs actual browser handshake evidence'
        );
        constraints['compressionNegotiationVerified'] = false;
      }
      for (const peer of peers) {
        assert.equal(
          peer.socket.extensions,
          compression.mode === 'none' ? '' : 'permessage-deflate',
          'Peer negotiated a different compression mode'
        );
      }
      const screenshot = `${values.output}.${scenario.name}.png`;
      await page.screenshot({ path: screenshot });
      assert.equal(errors.length, 0, `Browser errors: ${errors.join('\n')}`);
      if (warnings.length > 0) {
        failures.push(
          new Error(`${scenario.name} emitted browser warnings: ${warnings.join('\n')}`)
        );
      }
      runs.push({
        scenario,
        metadata,
        joined,
        durationMs,
        measuredFrames,
        intervals,
        warmupIntervals,
        restarts,
        health,
        generatorCpu,
        serverProcessCpu,
        proxyTransport,
        fixtures,
        finalizedHealth,
        measuredServerWindows,
        serverMeasurement: { startedAt: serverBoundary.endedAt, endedAt: serverTail.endedAt },
        populationSamples,
        ...(regionalWorkload
          ? {
              regionalWorld: {
                statusSampleCount: regionalStatusSamples.length,
                statusSamples: regionalStatusSamples,
                finalManifest: regionalFinalManifest,
                finalManifestFailure: regionalFinalManifestFailure,
                work: regionalWork,
                scanEvidence: regionalScanEvidence,
                decodedCorrelation: regionalDecodedWork.report(),
                scanRequired: seconds >= 30,
              },
            }
          : {}),
        combatWitness,
        desktopFire,
        inputSteps,
        inputActions,
        inputSchedule,
        acknowledgedMotionStates,
        observedProjectiles: observedProjectiles.size,
        peers: peers.map((peer) => peer.report()),
        performanceBudget: performanceBudget.report(),
        appliedFreshness: freshnessReport(),
        stateDelivery: {
          snapshotBytes: measuredSnapshotBytes,
          averageSnapshotBytes: measuredSnapshotBytes / Math.max(1, stateGaps.length),
          budget: delivery,
          startedAt: stateMeasuredStarted,
          endedAt: stateMeasuredEnded,
          gaps: completeStateGaps,
          states: stateGaps.length,
          finalStateAgeMs: stateTailGapMs,
        },
        constraints: {
          ...constraints,
          profile: networkProfiles[network],
          proxy: proxyStats,
        },
        errors,
        warnings,
        screenshot,
        input:
          scenario.hasTouch && values.browser === 'chromium'
            ? 'trusted simultaneous playfield steering/fire'
            : combatWorkload
              ? 'keyboard thrust/turn with trusted Space presses offered every 250ms'
              : 'keyboard thrust/turn and one shot offered per second',
        status: errors.length || warnings.length ? 'failed' : 'passed',
      });
    } catch (error) {
      measurementStoppedAt ||= performance.now();
      measuring = false;
      clearInterval(peerTimer);
      for (const peer of peers) {
        peer.stopMeasurement();
      }
      if (regionalWorkload && !regionalFinalManifestAttempted) {
        regionalFinalManifestAttempted = true;
        try {
          regionalFinalManifest = await readRegionalManifest(
            join(ownedSessionPath, 'fixture.sock')
          );
        } catch (manifestError) {
          regionalFinalManifestFailure = errorRecord(manifestError);
        }
      } else if (regionalWorkload && !regionalFinalManifest) {
        regionalFinalManifestFailure = errorRecord(error);
      }
      failures.push(error);
      try {
        constraints['proxy'] = JSON.parse(
          await readFile(join(sessionPath, 'proxy-stats.json'), 'utf8')
        );
      } catch (proxyError) {
        constraints['proxyError'] = String(proxyError);
      }
      runs.push({
        scenario,
        metadata,
        joined,
        serverProcessCpu,
        proxyTransport,
        constraints,
        fixtures,
        finalizedHealth,
        populationSamples,
        ...(regionalWorkload
          ? {
              regionalWorld: {
                statusSampleCount: regionalStatusSamples.length,
                statusSamples: regionalStatusSamples,
                finalManifest: regionalFinalManifest,
                finalManifestFailure: regionalFinalManifestFailure,
                work: regionalWork,
                scanEvidence: regionalScanEvidence,
                decodedCorrelation: regionalDecodedWork.report(),
                scanRequired: seconds >= 30,
              },
            }
          : {}),
        combatWitness,
        desktopFire,
        inputSteps,
        inputActions,
        inputSchedule,
        acknowledgedMotionStates,
        observedProjectiles: observedProjectiles.size,
        peers: peers.map((peer) => peer.report()),
        performanceBudget: performanceBudget.report(),
        appliedFreshness: freshnessReport(),
        stateDelivery: {
          snapshotBytes: measuredSnapshotBytes,
          averageSnapshotBytes: measuredSnapshotBytes / Math.max(1, stateGaps.length),
          budget: delivery,
          startedAt: stateMeasuredStarted,
          endedAt: measurementStoppedAt,
          gaps: [...stateGaps],
          states: stateGaps.length,
          finalStateAgeMs: lastMeasuredStateAt ? measurementStoppedAt - lastMeasuredStateAt : null,
        },
        status: 'failed',
        // Boundary failures can accompany the original observation failure.
        // Preserve every AggregateError member and cause in the scenario.
        failure: serializeBenchmarkError(error),
        errors,
        warnings,
        intervals,
        warmupIntervals,
        restarts,
        health,
      });
    } finally {
      measuredIntervals.push(...intervals);
      measuring = false;
      await stopDesktopFire();
      try {
        await markTraceMeasurementEnd();
      } catch (error) {
        cleanupComplete = false;
        failures.push(error);
      }
      try {
        await stopProfile();
      } catch (error) {
        cleanupComplete = false;
        failures.push(error);
      }
      try {
        await stopTrace();
      } catch (error) {
        cleanupComplete = false;
        failures.push(error);
      }
      if (tracePath) {
        try {
          await saveTraceBundles();
        } catch (error) {
          cleanupComplete = false;
          failures.push(error);
        }
      }
      clearInterval(peerTimer);
      for (const peer of peers) {
        peer.stopMeasurement();
      }
      const departure: Record<string, unknown> = { startedAt: new Date().toISOString() };
      const completedRun = runs.at(-1);
      if (completedRun) {
        completedRun['departure'] = departure;
      }
      try {
        await page.evaluate(() => window.gameController?.getNetworkManager().disconnect());
        departure['disconnectRequested'] = true;
      } catch (error) {
        cleanupComplete = false;
        failures.push(error);
        departure['disconnectError'] = errorRecord(error);
      }
      const peerClosures = await Promise.allSettled(peers.map((peer) => peer.close()));
      for (const result of peerClosures) {
        if (result.status === 'rejected') {
          cleanupComplete = false;
          failures.push(result.reason);
        }
      }
      try {
        const deadline = performance.now() + 10_000;
        const samples: Array<{ at: string; players: number }> = [];
        departure['samples'] = samples;
        let empty = false;
        while (performance.now() < deadline) {
          const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
          assert(response.ok, 'Departure health request failed');
          const departureHealth: unknown = await response.json();
          assert(
            departureHealth && typeof departureHealth === 'object' && 'world' in departureHealth
          );
          const world = departureHealth.world;
          assert(
            world &&
              typeof world === 'object' &&
              'players' in world &&
              typeof world.players === 'number'
          );
          samples.push({ at: new Date().toISOString(), players: world.players });
          if (world.players === 0) {
            empty = true;
            break;
          }
          await delay(100);
        }
        assert(empty, 'Previous scenario participants remain after graceful departure');
        departure['confirmedEmpty'] = true;
      } catch (error) {
        cleanupComplete = false;
        failures.push(error);
        departure['error'] = errorRecord(error);
      }
      try {
        await context.close();
        if (regionalWorkload && completedRun) {
          completedRun['largeSnapshotEvidence'] = await largeSnapshots.save(
            `${values.output}.${scenario.name}.large-snapshots.json`
          );
        }
      } catch (error) {
        cleanupComplete = false;
        failures.push(error);
      }
    }
    if (!cleanupComplete) {
      // A retained resumable player must never contaminate the next fixture.
      break;
    }
  }
} catch (error) {
  failures.push(error);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      cleanupComplete = false;
      failures.push(error);
    }
  }
  const measurement = cleanupComplete ? createMeasurement() : undefined;
  const report = createLiveReport({
    kind: 'realtime-client',
    ...(measurement ? { measurement } : {}),
    metadata: {
      ...collectLiveReportMetadata({
        browser: {
          name: values.browser ?? 'chromium',
          version: browserVersion,
          launchFlags: browserLaunchArgs,
          headed,
        },
        gpu,
        measurementSource: cases.some((scenario) => scenario.hasTouch) ? 'emulated-touch' : 'host',
      }),
      git: initialMetadata.git,
    },
    failed: failures.length > 0,
    details: {
      browser: values.browser,
      browserChannel,
      headed,
      browserVersion,
      cleanupComplete,
      profileRecorded,
      ...(values['cpu-profile'] ? { cpuProfile: values['cpu-profile'] } : {}),
      ...(tracePath
        ? {
            trace: {
              path: tracePath,
              recorded: (traceArtifact?.bytes ?? 0) > 0,
              complete: traceArtifact?.complete ?? false,
              bytes: traceArtifact?.bytes ?? 0,
              dataLossOccurred: traceArtifact?.dataLossOccurred ?? null,
              streamCompression: traceArtifact?.streamCompression ?? 'gzip',
              bundleManifest: traceBundleManifest,
              measurementMarks: {
                start: TRACE_MEASUREMENT_START_MARK,
                end: TRACE_MEASUREMENT_END_MARK,
                measure: TRACE_MEASUREMENT_MEASURE,
              },
            },
          }
        : {}),
      build: 'production',
      warmupSeconds: warmup,
      measuredSeconds: seconds,
      origin,
      scenarios: runs,
      failures: failures.map((error) => errorRecord(error)),
      limitations: [
        'Touch viewports are emulated browser contexts, not physical phone measurements.',
        'Animation timestamps measure scheduling and CPU submission, not GPU presentation.',
      ],
    },
  });
  try {
    await writeLiveReport(values.output ?? '.performance/client.json', report);
  } catch (error) {
    failures.push(error);
  }
}
if (failures.length) {
  throw new AggregateError(failures, 'Real-time client benchmark failed');
}
process.stdout.write(`Saved real-time client report to ${values.output}\n`);
