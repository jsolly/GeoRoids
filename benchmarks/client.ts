import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type BrowserServer, chromium } from 'playwright';
import type { ClientFixtureResult, ClientOptions } from './client-entry';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  'touch-portrait': { width: 390, height: 844 },
  'touch-landscape': { width: 844, height: 390 },
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

/** Compiled diagnostic fixture, not the deployed bundle; synchronous Canvas submission only. */
export async function runClientSample(options: ClientOptions) {
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffff_ffff ||
    !Number.isInteger(options.warmupFrames) ||
    options.warmupFrames < 1 ||
    !Number.isInteger(options.measuredFrames) ||
    options.measuredFrames < 1 ||
    options.warmupFrames + options.measuredFrames > 3600 ||
    !Object.hasOwn(VIEWPORTS, options.viewport)
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
        witness: ClientFixtureResult['witness'];
        parameters: object;
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
    browserServer = await chromium.launchServer({ headless: true, timeout: 30_000 });
    const browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 30_000 });
    async function runContext(observe: boolean): Promise<ClientFixtureResult> {
      const context = await deadline(
        browser.newContext({
          viewport: VIEWPORTS[options.viewport],
          hasTouch: options.viewport !== 'desktop',
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
            /\/(ws|logs)(?:\/|\?|$)/.test(request.url())
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
          if (message.type() === 'error') {
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
        await page.goto(`${origin}/benchmarks/client.html`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
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
      if (contextFailures.length) {
        throw new AggregateError(contextFailures, 'Client context failed');
      }
      if (!outcome) {
        throw new Error('Client context returned no outcome');
      }
      return outcome;
    }
    const timed = await runContext(false);
    const observed = await runContext(true);
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
      witness: { ...timed.witness, untimed: observed.witness.untimed },
      parameters: {
        ...options,
        fixture: 'compiled-diagnostic-visible-scene-v1',
        viewportPixels: VIEWPORTS[options.viewport],
        browserVersion: browser.version(),
        simulationStepMs: 1000 / 60,
        initialDateNow: 1_700_000_000_000,
        localPose: 'stationary-public-authoritative-mode',
        canvasAttributes: timed.canvasAttributes,
        timing:
          'native rAF intervals and synchronous update/render CPU submission; excludes GPU completion',
        observation: 'separate fresh context; real Canvas2D and Path2D method calls, not GPU draws',
        audio: 'native silent elements without sources, installed before game imports',
      },
      cleanup: 'complete',
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
