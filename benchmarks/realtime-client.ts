import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import { SnapshotDecoder } from '../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../shared-types';
import type { ClientPerformanceMetrics } from '../src/diagnostics/performanceMetrics';
import { PLAYFIELD_CLOSE_SCALE } from '../src/rendering/playfieldCamera';
import { finalizeServerWindow, prepareFixture } from './fixture-control';
import { observesPreparedFixture } from './fixture-readiness';
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
import type { Measurement } from './results';

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
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_');
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
    'cpu-profile': { type: 'string' },
    trace: { type: 'string' },
    'chromium-gpu': { type: 'boolean', default: false },
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
assert(!chromiumGpu || values.browser === 'chromium', 'chromium-gpu requires Chromium');
const browserLaunchArgs = chromiumGpu ? ['--enable-gpu'] : [];
const dpr = Number(values.dpr);
const cpuSlowdown = Number(values['cpu-slowdown']);
const seed = Number(values.seed);
const network = values.network;
const workload = values.scenario;
assert(Number.isFinite(dpr) && dpr >= 1 && dpr <= 4, 'dpr must be 1..4');
assert([1, 4, 6].includes(cpuSlowdown), 'cpu-slowdown must be 1, 4, or 6');
assert(
  Number.isSafeInteger(seed) && seed > 0 && seed === Number(process.env['GEOROIDS_BENCHMARK_SEED']),
  'seed must match owned server'
);
assert(network === 'clean' || network === 'normal' || network === 'degraded', 'Unknown network');
assert(workload === 'traversal' || workload === 'combat', 'Unknown scenario');
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
  { name: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false },
  { name: 'touch-portrait', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: 'touch-landscape', viewport: { width: 844, height: 390 }, hasTouch: true },
].filter((item) => values.viewport === 'all' || values.viewport === item.name);
assert(cases.length > 0, 'Unknown viewport');
const origin = `http://127.0.0.1:${process.env['GEOROIDS_TEST_VITE_PORT'] ?? 5173}`;
const healthUrl = `http://127.0.0.1:${process.env['GEOROIDS_TEST_SERVER_PORT'] ?? 3001}/health`;
type Interval = ReturnType<ClientPerformanceMetrics['read']>;
const runs: Array<Record<string, unknown>> = [];
const failures: unknown[] = [];
const measuredIntervals: Interval[] = [];
const joinIntervals: Interval[] = [];
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
    const values = metricSamples(name);
    if (values.length > 0) {
      samples[name] = values;
    }
  }
  const primaryMetric = samples['frameCpuMs']
    ? 'frameCpuMs'
    : samples['renderMs']
      ? 'renderMs'
      : Object.keys(samples)[0];
  if (!primaryMetric) {
    return undefined;
  }
  const requiredMetrics = ['parseMs', 'keyframeDecodeMs', 'deltaDecodeMs', 'applyMs', 'joinMs'];
  for (const name of requiredMetrics) {
    if (!samples[name]) {
      failures.push(new Error(`Real-time client report is missing ${name} samples`));
    }
  }
  return {
    primaryMetric,
    samples,
    counts: {
      scenarioRuns: runs.length,
      successfulScenarios: runs.filter((run) => run['status'] === 'passed').length,
      failedScenarios: runs.filter((run) => run['status'] === 'failed').length,
      measuredIntervals: measuredIntervals.length,
      rawSamples: Object.values(samples).reduce((sum, values) => sum + values.length, 0),
    },
    parameters: {
      browser: values.browser,
      browserChannel,
      dpr,
      cpuSlowdown,
      network,
      seed,
      workload,
      profileRecorded,
      renderDpr: values['render-dpr'],
      renderGlow: values['render-glow'],
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

async function drain(page: Page): Promise<Interval> {
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
    headless: true,
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
        const renderer = info.gpu.auxAttributes?.['glRenderer'];
        assert(
          typeof renderer === 'string' &&
            renderer.length > 0 &&
            !/swiftshader|llvmpipe|software/i.test(renderer),
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
      kind: 'browser-gameover' | 'peer-rejoin';
      startedAt: number;
      durationMs: number;
    }> = [];
    const health: unknown[] = [];
    const closedWindowIds = new Set<string>();
    const finalizedHealth: unknown[] = [];
    const peers: Pilot[] = [];
    let measuring = false;
    let peerTimer: ReturnType<typeof setInterval> | undefined;
    const sockets: string[] = [];
    let measuredPilotId: string | undefined;
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
    let measuredSnapshotBytes = 0;
    let lastMeasuredStateAt = 0;
    const stateGaps: Array<{ from: number; to: number; durationMs: number }> = [];
    let latestAuthoritativeState: ServerGameSnapshot | undefined;
    const populationSamples: unknown[] = [];
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
      dpr,
      cpuSlowdown,
      chromiumGpu,
      network,
      seed,
      workload,
      sockets,
    };
    const fixtures: Array<Awaited<ReturnType<typeof prepareFixture>>> = [];
    const context = await activeBrowser.newContext({
      viewport: scenario.viewport,
      hasTouch: scenario.hasTouch,
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
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
              decoder.reset();
              sequence = 0;
              acceptSnapshots = true;
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
          const motion = state.entities.find(
            (entity) => entity.id === measuredPilotId
          )?.playerMotion;
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
    let traceSession: CDPSession | undefined;
    let traceStarted = false;
    async function startTrace() {
      if (!tracePath) {
        return;
      }
      const session = await context.newCDPSession(page);
      traceSession = session;
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
      traceStarted = true;
    }
    async function stopTrace() {
      if (!traceSession) {
        return;
      }
      const session = traceSession;
      traceSession = undefined;
      let stopFailure: unknown;
      let stopFailed = false;
      try {
        if (traceStarted) {
          assert(tracePath);
          try {
            traceArtifact = await stopAndSaveTrace(session, tracePath);
            assert(!traceArtifact.dataLossOccurred, 'Chromium tracing reported data loss');
          } catch (error) {
            if (error instanceof TraceCaptureError) {
              traceArtifact = error.artifact;
            }
            stopFailed = true;
            stopFailure = error;
          }
        }
      } finally {
        traceStarted = false;
      }
      let detachFailure: unknown;
      let detachFailed = false;
      try {
        await withTimeout(
          session.detach(),
          TRACE_COMPLETION_TIMEOUT_MS,
          'Chromium tracing CDP detach'
        );
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
    }
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
      async function calibrate() {
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
        socketUrl.replace(/^ws:/, 'http:').replace(/\/ws$/, '/health'),
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
      if (network !== 'clean') {
        assert(new URL(socketUrl).port !== new URL(healthUrl).port, 'Impaired run bypasses proxy');
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
        `${origin}/?performance=collect&renderDpr=${values['render-dpr']}&renderGlow=${values['render-glow']}`,
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
      joined = await drain(page);
      joinIntervals.push(joined);
      metadata = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
        return {
          userAgent: navigator.userAgent,
          dpr: devicePixelRatio,
          css: canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : null,
          effectiveDpr: canvas?.clientWidth ? canvas.width / canvas.clientWidth : null,
          touchPoints: navigator.maxTouchPoints,
          backing: canvas ? { width: canvas.width, height: canvas.height } : null,
          visibility: document.visibilityState,
          clientReleaseId: window.georoidsPerformance?.read().clientReleaseId,
          serverReleaseId: window.georoidsPerformance?.read().serverReleaseId,
        };
      });
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
      for (let index = 0; index < (workload === 'combat' ? 4 : 0); index++) {
        await delay(1500);
        const peer = new Pilot(index, {
          url: new URL(`${socketUrl}?asteroidInteractions=1`),
          measuring: () => measuring,
          fail: (error) => errors.push(String(error)),
          deliveryBudget: () => delivery,
          repeatMeasuredPings: false,
        });
        peers.push(peer);
        const deadline = performance.now() + 10_000;
        while (!peer.state && performance.now() < deadline) {
          await delay(25);
        }
        assert(peer.state, 'Protocol peer failed admission');
      }
      let arranging = false;
      let preparedJoins: number[] = [];
      async function arrange(target: Interval[]) {
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
                player.lives > 0 &&
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
            measuredPilotId = id;
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
            assert.equal(
              fixture.hash,
              fixtures[0]?.hash,
              'Rejoined fixture differs from initial world'
            );
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
                  departed:
                    player?.id !== playerId ||
                    (player?.lives ?? 0) <= 0 ||
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
                  },
                  witness.observation
                ) &&
                peersReady
              ) {
                preparedJoins = joins;
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
      async function releaseInput() {
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
        }
      }
      async function applyInput() {
        const action = {
          startedAt: performance.now(),
          completedAt: undefined as number | undefined,
          measured: measuring,
        };
        inputActions.push(action);
        inputSteps++;
        await releaseInput();
        if (scenario.hasTouch && values.browser === 'chromium') {
          touchSession ??= await context.newCDPSession(page);
          const playfield = await page.locator('#gameCanvas').boundingBox();
          const extra = inputSteps % 20 === 0 ? '#touch-ability' : undefined;
          const extraBox =
            extra && (await page.locator(extra).getAttribute('aria-disabled')) !== 'true'
              ? await page.locator(extra).boundingBox()
              : null;
          assert(playfield, 'Playfield absent');
          const steerX = playfield.x + playfield.width * (inputSteps % 2 ? 0.8 : 0.2);
          const fireX = playfield.x + playfield.width * (inputSteps % 2 ? 0.2 : 0.8);
          const touchY = playfield.y + playfield.height * 0.5;
          await touchSession.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [
              { x: steerX, y: touchY, id: 1 },
              { x: fireX, y: touchY, id: 2 },
              ...(extraBox
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
          touchActive = true;
        } else {
          await page.keyboard.down('ArrowUp');
          await page.keyboard.down('ArrowLeft');
          await page.keyboard.press('Space');
          if (inputSteps % 20 === 0) {
            await page.keyboard.press('e');
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
        await page.locator('#start-game').waitFor({ state: 'visible', timeout: 6000 });
        await page.locator('#start-game').click();
        await page.waitForFunction(
          () =>
            window.gameController?.getNetworkManager().isConnected &&
            window.georoidsPerformance &&
            !window.georoidsPerformance.read().pendingJoin,
          undefined,
          { timeout: 10000 }
        );
        target.push(await drain(page));
        restarts.push({
          kind: 'browser-gameover',
          startedAt: restartAt,
          durationMs: performance.now() - restartAt,
        });
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
            target.push(await drain(page));
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
          if (peers.some((peer, index) => peer.gameJoins !== preparedJoins[index])) {
            const restartAt = performance.now();
            await releaseInput();
            const deadline = performance.now() + 10_000;
            while (peers.some((peer) => !peer.state) && performance.now() < deadline) {
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
          const interval = await drain(page);
          target.push(interval);
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
          if (camera && latestAuthoritativeState) {
            const state = latestAuthoritativeState;
            const visible = (position: { x: number; y: number }) =>
              Math.abs(position.x - camera.position.x) * PLAYFIELD_CLOSE_SCALE <=
                camera.width / 2 &&
              Math.abs(position.y - camera.position.y) * PLAYFIELD_CLOSE_SCALE <= camera.height / 2;
            const populations = {
              humans: state.entities.filter((entity) => entity.type === 'human'),
              bots: state.entities.filter((entity) => entity.type === 'bot'),
              asteroids: state.asteroids,
              pickups: state.satellitePickups,
              projectiles: state.playerProjectiles,
            };
            populationSamples.push({
              gameTime: state.gameTime,
              measured: target === intervals,
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
          const dead = await page.evaluate(
            () => (window.gameController?.getCurrPlayer()?.lives ?? 0) <= 0
          );
          if (dead) {
            await recoverBrowser(target);
            await arrange(target);
          } else {
            const frames = Object.entries(interval.metrics)
              .filter(([name]) => name.endsWith('.frameCpuMs'))
              .reduce((sum, [, metric]) => sum + metric.count, 0);
            assert(
              frames > 0 || interval.durationMs < 100,
              'No active game frames during observation'
            );
          }
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
      await observe(seconds * 1000, intervals);
      const stateMeasuredEnded = performance.now();
      measurementStoppedAt = stateMeasuredEnded;
      measuring = false;
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
      if (seconds >= 300) {
        assert(inputSteps >= 300, 'Insufficient distinct input steps');
      }
      const proxyStats: unknown =
        network === 'clean'
          ? null
          : JSON.parse(await readFile(join(sessionPath, 'proxy-stats.json'), 'utf8'));
      if (network !== 'clean') {
        assert(
          proxyStats &&
            typeof proxyStats === 'object' &&
            'bytesUp' in proxyStats &&
            typeof proxyStats.bytesUp === 'number' &&
            proxyStats.bytesUp > 0 &&
            'bytesDown' in proxyStats &&
            typeof proxyStats.bytesDown === 'number' &&
            proxyStats.bytesDown > 0,
          'No proxy traffic witnessed'
        );
        assert(
          'failures' in proxyStats && proxyStats.failures === 0,
          'Proxy recorded transport failures'
        );
      }
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
        fixtures,
        finalizedHealth,
        measuredServerWindows,
        serverMeasurement: { startedAt: serverBoundary.endedAt, endedAt: serverTail.endedAt },
        populationSamples,
        inputSteps,
        inputActions,
        inputSchedule,
        acknowledgedMotionStates,
        observedProjectiles: observedProjectiles.size,
        peers: peers.map((peer) => peer.report()),
        performanceBudget: performanceBudget.report(),
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
            : 'keyboard thrust/turn and four shots per second',
        status: errors.length || warnings.length ? 'failed' : 'passed',
      });
    } catch (error) {
      measurementStoppedAt ||= performance.now();
      measuring = false;
      clearInterval(peerTimer);
      for (const peer of peers) {
        peer.stopMeasurement();
      }
      failures.push(error);
      if (network !== 'clean') {
        try {
          constraints['proxy'] = JSON.parse(
            await readFile(join(sessionPath, 'proxy-stats.json'), 'utf8')
          );
        } catch (proxyError) {
          constraints['proxyError'] = String(proxyError);
        }
      }
      runs.push({
        scenario,
        metadata,
        joined,
        constraints,
        fixtures,
        finalizedHealth,
        populationSamples,
        inputSteps,
        inputActions,
        inputSchedule,
        acknowledgedMotionStates,
        observedProjectiles: observedProjectiles.size,
        peers: peers.map((peer) => peer.report()),
        performanceBudget: performanceBudget.report(),
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
        failure: errorRecord(error),
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
        const samples: Array<{ at: string; humanPlayers: number }> = [];
        departure['samples'] = samples;
        let empty = false;
        while (performance.now() < deadline) {
          const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
          assert(response.ok, 'Departure health request failed');
          const health: unknown = await response.json();
          assert(health && typeof health === 'object' && 'world' in health);
          const world = health.world;
          assert(
            world &&
              typeof world === 'object' &&
              'humanPlayers' in world &&
              typeof world.humanPlayers === 'number'
          );
          samples.push({ at: new Date().toISOString(), humanPlayers: world.humanPlayers });
          if (world.humanPlayers === 0) {
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
