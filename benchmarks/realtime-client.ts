import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { type Browser, type CDPSession, chromium, type Page, webkit } from 'playwright';
import type { ClientPerformanceMetrics } from '../src/diagnostics/performanceMetrics';
import {
  collectLiveReportMetadata,
  createLiveReport,
  errorRecord,
  validateHealth,
  writeLiveReport,
} from './live-report';
import type { Measurement } from './results';

const initialMetadata = collectLiveReportMetadata();

const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '180' },
    warmup: { type: 'string', default: '30' },
    viewport: { type: 'string', default: 'all' },
    browser: { type: 'string', default: 'chromium' },
    output: { type: 'string', default: '.performance/client.json' },
  },
});
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
assert(Number.isFinite(seconds) && seconds >= 1 && seconds <= 1800, 'seconds must be 1..1800');
assert(Number.isFinite(warmup) && warmup >= 0 && warmup <= 300, 'warmup must be 0..300');
assert(
  values.browser === 'chromium' || values.browser === 'webkit',
  'browser must be chromium or webkit'
);
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
    return recorder.read(true);
  });
}

try {
  browser = await (values.browser === 'webkit' ? webkit : chromium).launch({ headless: true });
  browserVersion = browser.version();
  const activeBrowser = browser;
  for (const scenario of cases) {
    process.stdout.write(`Starting ${scenario.name}: ${warmup}s warmup, ${seconds}s measurement\n`);
    const errors: string[] = [];
    const warnings: string[] = [];
    const intervals: Interval[] = [];
    const warmupIntervals: Interval[] = [];
    const restarts: Array<{ startedAt: number; durationMs: number }> = [];
    const health: unknown[] = [];
    const context = await activeBrowser.newContext({
      viewport: scenario.viewport,
      hasTouch: scenario.hasTouch,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
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
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let touchSession: CDPSession | undefined;
    let touchActive = false;
    try {
      await page.goto(`${origin}/?performance=collect`, { waitUntil: 'load' });
      await page.locator('#start-game').click();
      await page.waitForFunction(
        () =>
          window.gameController?.getNetworkManager().isConnected &&
          window.gameController.getCurrShip() &&
          window.georoidsPerformance &&
          !window.georoidsPerformance.read().pendingJoin,
        undefined,
        { timeout: 10_000 }
      );
      const joined = await drain(page);
      joinIntervals.push(joined);
      const metadata = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return {
          userAgent: navigator.userAgent,
          dpr: devicePixelRatio,
          touchPoints: navigator.maxTouchPoints,
          backing: canvas ? { width: canvas.width, height: canvas.height } : null,
          visibility: document.visibilityState,
          clientReleaseId: window.georoidsPerformance?.read().clientReleaseId,
          serverReleaseId: window.georoidsPerformance?.read().serverReleaseId,
        };
      });
      // Real input and real animation frames. No manual updateGame or source-module imports.
      async function releaseInput() {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = undefined;
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
        }
      }
      async function applyInput() {
        await releaseInput();
        if (scenario.hasTouch && values.browser === 'chromium') {
          touchSession ??= await context.newCDPSession(page);
          const stick = await page.locator('#touch-stick').boundingBox();
          const fire = await page.locator('#touch-fire').boundingBox();
          assert(stick && fire, 'Touch controls absent');
          await touchSession.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [
              { x: stick.x + stick.width * 0.8, y: stick.y + stick.height * 0.5, id: 1 },
              { x: fire.x + fire.width / 2, y: fire.y + fire.height / 2, id: 2 },
            ],
          });
          touchActive = true;
        } else {
          await page.keyboard.down('ArrowUp');
          await page.keyboard.down('ArrowLeft');
          intervalId = setInterval(() => {
            void page.keyboard.press('Space').catch((error: unknown) => errors.push(String(error)));
          }, 250);
        }
      }
      await applyInput();
      async function observe(duration: number, target: Interval[]) {
        const until = performance.now() + duration;
        let nextProgressAt = performance.now() + 30_000;
        while (performance.now() < until) {
          await delay(Math.max(1, Math.min(1000, until - performance.now())));
          const interval = await drain(page);
          target.push(interval);
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
            joinIntervals.push(await drain(page));
            await applyInput();
            restarts.push({ startedAt: restartAt, durationMs: performance.now() - restartAt });
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
          if (performance.now() >= nextProgressAt) {
            process.stdout.write(
              `${scenario.name} ${target === intervals ? 'measurement' : 'warmup'}: ${target.length} intervals, ${restarts.length} game rejoins\n`
            );
            nextProgressAt = performance.now() + 30_000;
          }
        }
      }
      await observe(warmup * 1000, warmupIntervals);
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      await observe(seconds * 1000, intervals);
      const durationMs = performance.now() - started;
      const generatorCpu = process.cpuUsage(cpuStart);
      const measuredFrames = intervals.reduce(
        (sum, interval) =>
          sum +
          (interval.metrics['play.frameCpuMs']?.count ?? 0) +
          (interval.metrics['respawn.frameCpuMs']?.count ?? 0),
        0
      );
      assert(measuredFrames > 0, 'No real game frames recorded');
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
      const screenshot = `${values.output}.${scenario.name}.png`;
      await page.screenshot({ path: screenshot });
      assert.equal(errors.length, 0, `Browser errors: ${errors.join('\n')}`);
      if (warnings.length > 0) {
        failures.push(
          new Error(`${scenario.name} emitted browser warnings: ${warnings.join('\n')}`)
        );
      }
      measuredIntervals.push(...intervals);
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
        errors,
        warnings,
        screenshot,
        input:
          scenario.hasTouch && values.browser === 'chromium'
            ? 'trusted simultaneous joystick/fire'
            : 'keyboard thrust/turn and four shots per second',
        status: errors.length || warnings.length ? 'failed' : 'passed',
      });
    } catch (error) {
      failures.push(error);
      runs.push({
        scenario,
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
      if (intervalId) {
        clearInterval(intervalId);
      }
      try {
        await context.close();
      } catch (error) {
        cleanupComplete = false;
        failures.push(error);
      }
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
        browser: { name: values.browser ?? 'chromium', version: browserVersion },
        measurementSource: cases.some((scenario) => scenario.hasTouch) ? 'emulated-touch' : 'host',
      }),
      git: initialMetadata.git,
    },
    failed: failures.length > 0,
    details: {
      browser: values.browser,
      browserVersion,
      cleanupComplete,
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
