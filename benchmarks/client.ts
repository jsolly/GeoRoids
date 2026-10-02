import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type BrowserServer, chromium } from 'playwright';
import { createClientConsoleDiagnostics } from './client-console-diagnostics';
import type { ClientFixtureResult, ClientOptions } from './client-entry';
import { clientSceneTraits, validateClientSceneFrames } from './client-scenes';

const WS_OR_LOGS_PATH_PATTERN = /\/(ws|logs)(?:\/|\?|$)/u;

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  'touch-portrait': { width: 390, height: 844 },
  'touch-landscape': { width: 844, height: 390 },
  tablet: { width: 1024, height: 768 },
};

async function deadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Compile in an owned subprocess so even a stuck build can be terminated before cleanup.
async function compileFixture(output: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--build-client', output],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let log = '';
  child.stdout.on('data', (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-16_000);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-16_000);
  });
  const closed = new Promise<void>((resolveClosed, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveClosed();
      } else {
        reject(new Error(`Client fixture build failed (${code ?? signal}): ${log}`));
      }
    });
  });
  try {
    await deadline(closed, 90_000, 'Client compilation');
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await deadline(
        closed.catch(() => undefined),
        10_000,
        'Client compiler cleanup'
      );
    }
    throw error;
  }
}

/** Compiled diagnostic fixture; frame intervals and synchronous CPU submission. */
export async function runClientSample(options: ClientOptions) {
  const scene = options.scene ?? 'stationary';
  const traits = clientSceneTraits(scene);
  validateClientSceneFrames(scene, options.warmupFrames, options.measuredFrames);
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffff_ffff ||
    !Number.isInteger(options.warmupFrames) ||
    options.warmupFrames < 1 ||
    !Number.isInteger(options.measuredFrames) ||
    options.measuredFrames < 1 ||
    options.warmupFrames + options.measuredFrames > 3600 ||
    !Object.hasOwn(VIEWPORTS, options.viewport) ||
    !Number.isFinite(options.dpr ?? 1) ||
    (options.dpr ?? 1) < 1 ||
    (options.dpr ?? 1) > 4 ||
    !['canvas', 'webgl2'].includes(options.renderer ?? 'canvas')
  ) {
    throw new Error('Invalid client seed, viewport, or frame counts (maximum 3600 total frames)');
  }
  const directory = await mkdtemp(join(tmpdir(), 'georoids-compiled-client-'));
  const output = join(directory, 'dist');
  const failures: unknown[] = [];
  let browserServer: BrowserServer | undefined;
  const trafficFailures: string[] = [];
  const server = createServer((request, response) => {
    const serve = async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const file = resolve(output, `.${pathname}`);
      if (relative(output, file).startsWith('..')) {
        throw new Error(`Invalid fixture path: ${pathname}`);
      }
      const bytes = await readFile(file);
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
        '.json': 'application/json',
      };
      response.writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(bytes);
    };
    void serve().catch((error: unknown) => {
      trafficFailures.push(error instanceof Error ? error.message : String(error));
      response.writeHead(404);
      response.end();
    });
  });
  server.on('upgrade', (_request, socket) => {
    trafficFailures.push('Unexpected WebSocket upgrade');
    socket.destroy();
  });
  let result:
    | {
        primaryMetric: string;
        samples: ClientFixtureResult['samples'];
        counts: ClientFixtureResult['counts'];
        frameWork: ClientFixtureResult['frameWork'];
        frameImageSha256: ClientFixtureResult['frameImageSha256'];
        witness: ClientFixtureResult['witness'];
        parameters: object;
        gpuObservation: object;
        consoleDiagnostics: {
          timing: ReturnType<ReturnType<typeof createClientConsoleDiagnostics>['finish']>;
          observation: ReturnType<ReturnType<typeof createClientConsoleDiagnostics>['finish']>;
        };
        cleanup: 'complete';
      }
    | undefined;
  try {
    await compileFixture(output);
    await new Promise<void>((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListening);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('No loopback fixture port');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    browserServer = await chromium.launchServer({
      headless: true,
      timeout: 30_000,
      ...(options.chromiumGpu ? { channel: 'chromium', args: ['--enable-gpu'] } : {}),
    });
    const browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 30_000 });
    const session = await browser.newBrowserCDPSession();
    const { gpu } = await session.send('SystemInfo.getInfo');
    await session.detach();
    if (options.chromiumGpu) {
      const renderer: unknown = gpu.auxAttributes?.['glRenderer'];
      if (
        typeof renderer !== 'string' ||
        renderer.length === 0 ||
        /swiftshader|llvmpipe|software/iu.test(renderer)
      ) {
        throw new Error('Requested hardware GPU path was not observed');
      }
      for (const feature of ['2d_canvas', 'gpu_compositing', 'rasterization']) {
        const status: unknown = gpu.featureStatus?.[feature];
        if (status !== 'enabled' && status !== 'enabled_on') {
          throw new Error(`Requested GPU path lacks accelerated ${feature}`);
        }
      }
    }
    async function runContext(observe: boolean) {
      // Each declared checkpoint captures once. The final frame reuses that
      // capture when it is a checkpoint; otherwise it adds exactly one readback.
      const plannedCaptures = observe
        ? traits.checkpoints.length + (traits.checkpoints.includes(options.measuredFrames) ? 0 : 1)
        : 0;
      const consoleDiagnostics = createClientConsoleDiagnostics(
        observe ? 'observation' : 'timing',
        plannedCaptures
      );
      const context = await deadline(
        browser.newContext({
          viewport: VIEWPORTS[options.viewport],
          hasTouch: options.viewport !== 'desktop',
          deviceScaleFactor: options.dpr ?? 1,
          serviceWorkers: 'block',
        }),
        30_000,
        'Browser context setup'
      );
      const contextFailures: unknown[] = [];
      let outcome: ClientFixtureResult | undefined;
      try {
        await context.route('**/*', (route) => {
          const request = route.request();
          if (
            new URL(request.url()).origin !== origin ||
            request.resourceType() === 'media' ||
            WS_OR_LOGS_PATH_PATTERN.test(request.url())
          ) {
            trafficFailures.push(`Unexpected ${request.resourceType()} request: ${request.url()}`);
            return route.abort();
          }
          return route.continue();
        });
        await context.routeWebSocket('**/*', (socket) => {
          trafficFailures.push(`Unexpected WebSocket: ${socket.url()}`);
          socket.close();
        });
        const page = await deadline(context.newPage(), 30_000, 'Browser page setup');
        page.on('pageerror', (error) => contextFailures.push(error));
        page.on('console', (message) => {
          if (message.type() === 'warning') {
            consoleDiagnostics.warning(message.text());
          } else if (message.type() === 'error') {
            contextFailures.push(new Error(message.text()));
          }
        });
        page.on('requestfailed', (request) =>
          contextFailures.push(new Error(`Request failed: ${request.url()}`))
        );
        page.on('response', (response) => {
          if (!response.ok()) {
            contextFailures.push(new Error(`HTTP ${response.status()}: ${response.url()}`));
          }
        });
        await page.goto(
          `${origin}/benchmarks/client.html?renderer=${options.renderer ?? 'canvas'}`,
          {
            waitUntil: 'load',
            timeout: 30_000,
          }
        );
        await page.waitForFunction('typeof window.runClientFixture === "function"', undefined, {
          timeout: 30_000,
        });
        // A string expression avoids transferring uncompiled tsx helpers into Chromium.
        outcome = await deadline(
          page.evaluate<ClientFixtureResult>(
            `window.runClientFixture(${JSON.stringify({ ...options, observe })})`
          ),
          90_000,
          observe ? 'Client observation' : 'Client timing'
        );
      } catch (error) {
        contextFailures.push(error);
      }
      try {
        await deadline(context.close(), 10_000, 'Browser context cleanup');
      } catch (error) {
        contextFailures.push(error);
      }
      let diagnostics: ReturnType<typeof consoleDiagnostics.finish> | undefined;
      try {
        diagnostics = consoleDiagnostics.finish(outcome?.observationCaptures ?? 0);
      } catch (error) {
        contextFailures.push(error);
      }
      if (contextFailures.length) {
        throw new AggregateError(contextFailures, 'Client context failed');
      }
      if (!outcome || !diagnostics) {
        throw new Error('Client context returned no outcome or diagnostic receipt');
      }
      return { outcome, diagnostics };
    }
    const timingContext = await runContext(false);
    const observationContext = await runContext(true);
    const timed = timingContext.outcome;
    const observed = observationContext.outcome;
    if (
      JSON.stringify(timed.witness.before) !== JSON.stringify(observed.witness.before) ||
      JSON.stringify(timed.witness.after) !== JSON.stringify(observed.witness.after)
    ) {
      throw new Error('Timing and observation contexts executed different scene outcomes');
    }
    for (const values of Object.values(timed.samples)) {
      if (
        values.length !== options.measuredFrames ||
        values.some((value) => !Number.isFinite(value) || value < 0)
      ) {
        throw new Error('Incomplete or invalid client timing samples');
      }
    }
    result = {
      primaryMetric: 'renderMs',
      samples: timed.samples,
      counts: observed.counts,
      frameWork: observed.frameWork,
      frameImageSha256: observed.frameImageSha256,
      witness: {
        ...timed.witness,
        untimed: {
          ...observed.witness.untimed,
          renderer: { backend: observed.rendererBackend, gpuStats: observed.gpuFrameStats },
        },
      },
      parameters: {
        ...options,
        renderer: options.renderer ?? 'canvas',
        dpr: options.dpr ?? 1,
        chromiumGpu: options.chromiumGpu ?? false,
        fixture:
          scene === 'stationary'
            ? 'compiled-diagnostic-visible-scene-v1'
            : 'compiled-diagnostic-visible-scene-v2',
        scene,
        sceneTraits: traits,
        presentationClock: traits.presentationClock,
        contourEndpointProbeCoverage:
          scene === 'stationary' ? 'initial-contour-set' : 'not-instrumented: dynamic terrain sets',
        viewportPixels: VIEWPORTS[options.viewport],
        browserVersion: browser.version(),
        simulationStepMs: 1000 / 60,
        initialDateNow: 1_700_000_000_000,
        localPose: 'stationary-public-authoritative-mode',
        canvasAttributes: timed.canvasAttributes,
        rendererBackend: timed.rendererBackend,
        gpu: {
          devices: gpu.devices,
          renderer: Object.fromEntries(
            Object.entries(gpu.auxAttributes ?? {}).filter(([key]) =>
              [
                'glRenderer',
                'glVendor',
                'glVersion',
                'displayType',
                'passthroughCmdDecoder',
              ].includes(key)
            )
          ),
          featureStatus: gpu.featureStatus,
        },
        timing:
          'native rAF intervals and native-clock synchronous update/render CPU submission; excludes GPU completion',
        observation:
          'separate fresh context; real Canvas2D, Path2D and WebGL2 method calls; composed final image captured synchronously after drawing',
        audio: 'native silent elements without sources, installed before game imports',
      },
      cleanup: 'complete',
      gpuObservation: gpu,
      consoleDiagnostics: {
        timing: timingContext.diagnostics,
        observation: observationContext.diagnostics,
      },
    };
  } catch (error) {
    failures.push(error);
  }
  if (browserServer) {
    try {
      await deadline(browserServer.close(), 10_000, 'Browser cleanup');
    } catch (error) {
      failures.push(error);
      const child = browserServer.process();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolveExited) =>
          child.once('close', () => resolveExited())
        );
        child.kill('SIGKILL');
        try {
          await deadline(exited, 10_000, 'Forced browser cleanup');
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
    }
  }
  if (server.listening) {
    server.closeAllConnections();
    try {
      await deadline(
        new Promise<void>((resolveClosed, reject) =>
          server.close((error) => (error ? reject(error) : resolveClosed()))
        ),
        10_000,
        'Static server cleanup'
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await deadline(
      rm(directory, { recursive: true, force: true }),
      10_000,
      'Client artifact cleanup'
    );
  } catch (error) {
    failures.push(error);
  }
  if (trafficFailures.length) {
    failures.push(new Error(trafficFailures.join('\n')));
  }
  if (failures.length) {
    throw new AggregateError(failures, 'Client measurement or cleanup failed');
  }
  if (!result) {
    throw new Error('Client measurement produced no result');
  }
  return result;
}

const entryPath = process.argv[1];
if (
  entryPath &&
  import.meta.url === pathToFileURL(entryPath).href &&
  process.argv[2] === '--build-client'
) {
  const output = process.argv[3];
  if (!output) {
    throw new Error('Client build requires an output directory');
  }
  const { build } = await import('vite');
  await build({
    root: ROOT,
    configFile: false,
    envFile: false,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: { input: join(ROOT, 'benchmarks/client.html') },
    },
  });
}
