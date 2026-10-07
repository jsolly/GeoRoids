import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type JSHandle } from 'playwright';
import type { TouchControlDiagnostics } from '../../src/input/touchControls';
import { ownedProcessGroupAbsent } from './owned-process-group';

type Viewport = { width: number; height: number };
type InputBoundary = {
  readTouchControlDiagnostics(): TouchControlDiagnostics;
  keys: Record<string, boolean>;
};
type LifecycleSnapshot = {
  controls: TouchControlDiagnostics & { pressedKeys: string[]; canShoot: boolean };
  hidden: boolean;
  hiddenEvents: number;
  visibleEvents: number;
  freezeEvents: number;
  resumeEvents: number;
  untrustedEvents: number;
  trustedInputs: number;
  untrustedInputs: number;
  frameCpuCount: number;
  rendererFrameCount: number;
  rendererBackend: 'canvas' | 'webgl2' | null;
  viewport: { width: number; height: number; dpr: number };
  rafCallbacks: number;
  callbacksAtFreeze: number;
  callbacksAtResume: number;
  framesAtFreeze: number;
  framesAtResume: number;
};
type LifecycleObservation = { read(): LifecycleSnapshot; dispose(): void };

async function bounded<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  do {
    const value = await bounded(read(), 2000, 'Native lifecycle observation did not settle');
    if (accepts(value)) {
      return value;
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('Owned browser did not reach the required native lifecycle state');
}

/** Attempt every owned restoration, retaining each concrete failure. */
export async function attemptScenarioCleanup(
  actions: readonly (() => Promise<unknown>)[]
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, 'Scenario cleanup failed');
  }
}

/** A cleanup failure must never replace the original scenario failure. */
export async function withScenarioCleanup<T>(
  run: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failures: unknown[] = outcome.ok ? [] : [outcome.error];
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'Scenario and cleanup failed');
  }
  assert(outcome.ok);
  return outcome.value;
}

/** Explicitly omit transport payloads, URLs and decoder error strings from receipts. */
export function readWireCounters(wire: {
  read(): {
    snapshots: number;
    connections: number;
    closedConnections: number;
    gameTime: number | undefined;
    errors: readonly string[];
  };
}) {
  const state = wire.read();
  return {
    snapshots: state.snapshots,
    connections: state.connections,
    closedConnections: state.closedConnections,
    gameTime: state.gameTime,
    protocolErrors: state.errors.length,
  };
}

type HostEvent = { atMs: number; kind: string; freezeCycle: number | null; data: unknown };
function safeNativeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}
function safeNativeText(value: string): string {
  return value
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gu, safeNativeUrl)
    .replace(
      /(\b(?:resumeToken|sessionToken|authorization|credential|token)\b["']?\s*[:=]\s*["']?)([^\s,"'&}]+)/giu,
      '$1[redacted]'
    )
    .slice(0, 4000);
}

/** Disable only Vite's development transport; retain its CSS and hot-context APIs. */
export function disableViteClientTransport(source: string) {
  const boot = 'transport.connect(createHMRHandler(handleMessage));';
  const starts = [
    ...source.matchAll(/^transport\.connect\(createHMRHandler\(handleMessage\)\);$/gmu),
  ];
  assert.equal(starts.length, 1, 'Expected exactly one pinned Vite client transport bootstrap');
  assert.equal(source.split(boot).length, 2, 'Unexpected duplicate Vite transport bootstrap');
  const start = starts[0];
  assert(start);
  const body = source.slice(0, start.index) + source.slice(start.index + boot.length);
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  return { body, originalSha256: sha256(source), transformedSha256: sha256(body) };
}

/** A separate browser avoids Playwright's per-session visible capture handle.
 * noDefaults only applies to the existing default context, never newContext().
 */
export async function createNativeLifecycleBrowser(
  options: Viewport & { hasTouch: boolean },
  ownCleanup: (cleanup: () => Promise<void>) => void
) {
  const profile = await mkdtemp(join(tmpdir(), 'georoids-native-lifecycle-'));
  const executablePath = chromium.executablePath();
  const launchArgs = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Match Playwright's standard software-WebGL permission without its focus capture.
    '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    `--window-size=${options.width},${options.height}`,
    'about:blank',
  ];
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./owned-native-browser.mjs', import.meta.url)),
      executablePath,
      ...launchArgs,
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
  const childStderr = child.stderr;
  assert(childStderr, 'Owned native launcher requires a piped stderr');
  let spawnFailed = false;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => {
      spawnFailed = true;
      resolve();
    });
  });
  let browser: Browser | undefined;
  let observer: JSHandle<LifecycleObservation> | undefined;
  let closing: Promise<void> | undefined;
  let stderr = '';
  let restoreWindow: (() => Promise<void>) | undefined;
  const startedAt = Date.now();
  const hostEvents: HostEvent[] = [];
  let mainNavigations = 0;
  let documentBaseline: number | undefined;
  let crashes = 0;
  let pageClosed = false;
  let hmrSockets = 0;
  let viteClientResponses = 0;
  let viteClientFailure: unknown;
  let socketCount = 0;
  let freezeCycle = 0;
  let freezeDeadline = 0;
  let endpointOrigin: string | undefined;
  let lastObservation: LifecycleSnapshot | undefined;
  const recordHost = (kind: string, data: unknown) => {
    hostEvents.push({
      atMs: Date.now() - startedAt,
      kind,
      freezeCycle: freezeCycle > 0 && Date.now() <= freezeDeadline ? freezeCycle : null,
      data,
    });
    if (hostEvents.length > 128) {
      hostEvents.shift();
    }
  };
  function diagnostics() {
    return structuredClone({
      browserVersion: browser?.version(),
      launch: { executablePath, args: launchArgs, initialDevice: options },
      pid: child.pid,
      pgid: child.pid,
      profile,
      endpointOrigin,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      stderr: safeNativeText(stderr),
      mainNavigations,
      documentBaseline,
      crashes,
      pageClosed,
      hmrSockets,
      viteClientResponses,
      lastObservation,
      events: hostEvents,
    });
  }
  recordHost('owned-process', { pid: child.pid, pgid: child.pid, profile });
  function close(): Promise<void> {
    if (closing !== undefined) {
      return closing;
    }
    closing = (async () => {
      const failures: unknown[] = [];
      if (browser?.isConnected() && restoreWindow) {
        try {
          await bounded(restoreWindow(), 5000, 'Native window cleanup timed out');
        } catch (error) {
          failures.push(error);
        }
      }
      if (observer) {
        try {
          await bounded(
            observer.evaluate((witness) => witness.dispose()),
            2000,
            'Lifecycle observer cleanup timed out'
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await bounded(observer.dispose(), 2000, 'Lifecycle handle cleanup timed out');
        } catch (error) {
          failures.push(error);
        }
      }
      if (browser?.isConnected()) {
        try {
          const control = await bounded(
            browser.newBrowserCDPSession(),
            2000,
            'Browser cleanup connection timed out'
          );
          await bounded(
            control.send('Browser.close'),
            2000,
            'Owned browser close request timed out'
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await bounded(browser.close(), 2000, 'Browser transport cleanup timed out');
        } catch (error) {
          failures.push(error);
        }
      }
      async function groupAbsent(): Promise<boolean> {
        if (!child.pid) {
          assert(spawnFailed, 'Missing owned Chromium PID without a failed spawn');
          return true;
        }
        return await ownedProcessGroupAbsent(child.pid, (observation) => {
          if (observation.kind === 'signal-error') {
            recordHost('group-absence-error', {
              pid: child.pid,
              error: safeNativeText(String(observation.error)),
            });
          } else {
            recordHost('owned-group-inventory-proof', {
              pgid: child.pid,
              absent: observation.absent,
            });
          }
        });
      }
      async function waitForGroupAbsent(milliseconds: number): Promise<boolean> {
        const deadline = Date.now() + milliseconds;
        do {
          if (await groupAbsent()) {
            return true;
          }
          await delay(25);
        } while (Date.now() < deadline);
        return groupAbsent();
      }
      let groupGone = false;
      try {
        groupGone = await waitForGroupAbsent(2000);
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
          if (groupGone) {
            break;
          }
          assert(child.pid, 'Missing owned Chromium PID');
          try {
            // The helper owns this detached group, including children after its leader exits.
            recordHost('owned-group-signal', { pgid: child.pid, signal });
            process.kill(-child.pid, signal);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
              failures.push(error);
            }
          }
          groupGone = await waitForGroupAbsent(1000);
        }
        await bounded(exited, 1000, 'Owned Chromium exit was not observed');
      } catch (error) {
        failures.push(error);
      }
      if (groupGone) {
        try {
          await rm(profile, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      } else {
        failures.push(
          new Error(
            `Owned browser profile retained because its process group remains or could not be verified absent: ${profile}`
          )
        );
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Native browser cleanup failed');
      }
    })();
    return closing;
  }
  ownCleanup(close);
  try {
    const endpoint = await bounded(
      new Promise<string>((resolve, reject) => {
        childStderr.on('data', (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString()}`.slice(-16384);
          const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
          if (match?.[1]) {
            resolve(match[1]);
          }
        });
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          reject(new Error(`Owned Chromium exited ${code}/${signal}: ${stderr}`))
        );
      }),
      10000,
      'Owned Chromium did not expose its CDP endpoint'
    );
    endpointOrigin = new URL(endpoint).origin;
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10000 });
    const context = browser.contexts()[0];
    assert(context, 'Missing existing default browser context');
    const startupPages = context.pages();
    const page = await context.newPage();
    await page.route(
      (url) => url.pathname === '/@vite/client',
      async (route) => {
        try {
          const response = await route.fetch({ timeout: 5000, maxRedirects: 0 });
          assert.equal(response.status(), 200, 'Vite client bootstrap response was not successful');
          const transformed = disableViteClientTransport(await response.text());
          await route.fulfill({ response, body: transformed.body });
          viteClientResponses++;
          recordHost('HMR-client-transport-disabled', {
            url: safeNativeUrl(route.request().url()),
            originalSha256: transformed.originalSha256,
            transformedSha256: transformed.transformedSha256,
          });
        } catch (error) {
          viteClientFailure = error;
          recordHost('HMR-client-transform-failed', { error: safeNativeText(String(error)) });
          await route.abort('failed');
        }
      }
    );
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        mainNavigations++;
        recordHost('main-navigation', { url: safeNativeUrl(frame.url()) });
      }
    });
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        recordHost('main-navigation-request', { url: safeNativeUrl(request.url()) });
      }
    });
    page.on('crash', () => {
      crashes++;
      recordHost('page-crash', null);
    });
    page.on('pageerror', (error) => recordHost('page-error', safeNativeText(error.message)));
    page.on('close', () => {
      pageClosed = true;
      recordHost('page-close', null);
    });
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('[vite]') || message.type() === 'error' || message.type() === 'warning') {
        recordHost('console', {
          level: message.type(),
          text: safeNativeText(text),
          location: {
            url: safeNativeUrl(message.location().url),
            line: message.location().lineNumber,
          },
        });
      }
    });
    page.on('websocket', (socket) => {
      const socketId = ++socketCount;
      const url = safeNativeUrl(socket.url());
      if (new URL(socket.url()).pathname === '/') {
        hmrSockets++;
      }
      recordHost('socket-created', { socketId, url });
      socket.on('close', () => recordHost('socket-close', { socketId, url }));
      socket.on('socketerror', (error) =>
        recordHost('socket-error', { socketId, url, error: safeNativeText(error) })
      );
    });
    for (const startupPage of startupPages) {
      await startupPage.close();
    }
    await context.addInitScript(() => {
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        localStorage.setItem('musicOn', 'false');
      }
    });
    const session = await context.newCDPSession(page);
    const control = await browser.newBrowserCDPSession();
    const { frameTree } = await session.send('Page.getFrameTree');
    session.on('Page.frameStartedLoading', ({ frameId }: { frameId: string }) => {
      if (frameId === frameTree.frame.id) {
        recordHost('main-start-load', null);
      }
    });
    session.on('Inspector.targetCrashed', () => {
      crashes++;
      recordHost('inspector-crash', null);
    });
    session.on('Inspector.detached', ({ reason }: { reason: string }) =>
      recordHost('inspector-detached', safeNativeText(reason))
    );
    await session.send('Inspector.enable');
    const { targetInfo } = await session.send('Target.getTargetInfo');
    const { windowId } = await control.send('Browser.getWindowForTarget', {
      targetId: targetInfo.targetId,
    });
    const setWindowState = (windowState: 'normal' | 'minimized') =>
      bounded(
        control.send('Browser.setWindowBounds', { windowId, bounds: { windowState } }),
        2000,
        'Native window control timed out'
      );
    async function resize(viewport: Viewport): Promise<void> {
      await page.setViewportSize(viewport);
      const landscape = viewport.width > viewport.height;
      await session.send('Emulation.setDeviceMetricsOverride', {
        ...viewport,
        deviceScaleFactor: options.hasTouch ? 2 : 1,
        mobile: options.hasTouch,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
        screenOrientation: {
          type: landscape ? 'landscapePrimary' : 'portraitPrimary',
          angle: landscape ? 90 : 0,
        },
      });
      await session.send('Emulation.setTouchEmulationEnabled', {
        enabled: options.hasTouch,
        maxTouchPoints: options.hasTouch ? 5 : 1,
      });
    }
    await resize(options);
    // A new headless window may report visible before its compositor is active.
    // Toggle its real owner through hidden/normal; no script fakes visibility or RAF.
    await setWindowState('minimized');
    await waitFor(() => page.evaluate(() => document.hidden), Boolean);
    await setWindowState('normal');
    await bounded(page.bringToFront(), 2000, 'Native foreground request timed out');
    await waitFor(
      () => page.evaluate(() => document.hidden),
      (hidden) => !hidden
    );
    await session.send('Page.enable');
    async function restore(): Promise<void> {
      await bounded(
        session.send('Page.setWebLifecycleState', { state: 'active' }),
        2000,
        'Native resume request timed out'
      );
      await setWindowState('normal');
      await bounded(page.bringToFront(), 2000, 'Native foreground request timed out');
      await waitFor(
        () => page.evaluate(() => document.hidden),
        (hidden) => !hidden
      );
    }
    restoreWindow = restore;
    async function observeGame(): Promise<void> {
      assert(!observer, 'Native lifecycle observation already installed');
      const inputs = await page.evaluateHandle<InputBoundary>(
        "Promise.all([import('/src/input/touchControls.ts'), import('/src/input/keybindings.ts')]).then(([touch, keyboard]) => ({readTouchControlDiagnostics: touch.readTouchControlDiagnostics, keys: keyboard.keys}))"
      );
      try {
        observer = await inputs.evaluateHandle((bindings) => {
          function frameCount(): number {
            return Object.entries(window.georoidsPerformance?.read().metrics ?? {})
              .filter(([name]) => name.endsWith('.frameCpuMs'))
              .reduce((total, [, metric]) => total + metric.count, 0);
          }
          const counts = {
            hiddenEvents: 0,
            visibleEvents: 0,
            freezeEvents: 0,
            resumeEvents: 0,
            untrustedEvents: 0,
            trustedInputs: 0,
            untrustedInputs: 0,
            rafCallbacks: 0,
            callbacksAtFreeze: 0,
            callbacksAtResume: 0,
            framesAtFreeze: 0,
            framesAtResume: 0,
          };
          const requestFrame = window.requestAnimationFrame;
          const observeFrame: typeof requestAnimationFrame = (callback) =>
            requestFrame.call(window, (timestamp) => {
              counts.rafCallbacks++;
              callback(timestamp);
            });
          window.requestAnimationFrame = observeFrame;
          const visibility = (event: Event) => {
            if (!event.isTrusted) {
              counts.untrustedEvents++;
            }
            if (document.hidden) {
              counts.hiddenEvents++;
            } else {
              counts.visibleEvents++;
            }
          };
          const freeze = (event: Event) => {
            if (!event.isTrusted) {
              counts.untrustedEvents++;
            }
            counts.freezeEvents++;
            counts.framesAtFreeze = frameCount();
            counts.callbacksAtFreeze = counts.rafCallbacks;
          };
          const observeResume = (event: Event) => {
            if (!event.isTrusted) {
              counts.untrustedEvents++;
            }
            counts.resumeEvents++;
            counts.framesAtResume = frameCount();
            counts.callbacksAtResume = counts.rafCallbacks;
          };
          const inputEvent = (event: Event) => {
            if (event.isTrusted) {
              counts.trustedInputs++;
            } else {
              counts.untrustedInputs++;
            }
          };
          document.addEventListener('pointerdown', inputEvent, true);
          document.addEventListener('keydown', inputEvent, true);
          document.addEventListener('visibilitychange', visibility);
          document.addEventListener('freeze', freeze);
          document.addEventListener('resume', observeResume);
          return {
            read: () => ({
              ...counts,
              hidden: document.hidden,
              frameCpuCount: frameCount(),
              rendererFrameCount:
                (window.georoidsPerformance?.read().renderer.frames.canvas ?? 0) +
                (window.georoidsPerformance?.read().renderer.frames.webgl2 ?? 0),
              rendererBackend: window.georoidsPerformance?.read().renderer.backend ?? null,
              viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
              controls: {
                ...bindings.readTouchControlDiagnostics(),
                pressedKeys: Object.keys(bindings.keys).filter((key) => bindings.keys[key]),
                canShoot: window.gameController?.getCurrPlayer()?.ship.canShoot === true,
              },
            }),
            dispose: () => {
              if (window.requestAnimationFrame === observeFrame) {
                window.requestAnimationFrame = requestFrame;
              }
              document.removeEventListener('pointerdown', inputEvent, true);
              document.removeEventListener('keydown', inputEvent, true);
              document.removeEventListener('visibilitychange', visibility);
              document.removeEventListener('freeze', freeze);
              document.removeEventListener('resume', observeResume);
            },
          };
        });
      } finally {
        await inputs.dispose();
      }
    }
    async function read(): Promise<LifecycleSnapshot> {
      assert(observer, 'Native lifecycle observation has not been installed');
      const observation = await bounded(
        observer.evaluate((witness) => witness.read()),
        2000,
        'Native lifecycle read timed out'
      );
      lastObservation = observation;
      return observation;
    }
    async function hideAndFreeze(): Promise<LifecycleSnapshot> {
      const before = await read();
      assert(
        !before.hidden && before.frameCpuCount > 0 && before.rafCallbacks > 0,
        'Freeze requires a visible, executing game'
      );
      await setWindowState('minimized');
      await waitFor(
        read,
        (state) => state.hidden && state.hiddenEvents === before.hiddenEvents + 1
      );
      freezeCycle++;
      freezeDeadline = Date.now() + 10000;
      recordHost('native-freeze-request', null);
      await bounded(
        session.send('Page.setWebLifecycleState', { state: 'frozen' }),
        2000,
        'Native freeze request timed out'
      );
      const frozen = await waitFor(read, (state) => state.freezeEvents === before.freezeEvents + 1);
      assert(
        frozen.hidden && frozen.untrustedEvents === 0,
        'Freeze must follow trusted native hide'
      );
      assert.equal(
        frozen.frameCpuCount,
        frozen.framesAtFreeze,
        'Game callbacks continued after native freeze'
      );
      assert.equal(
        frozen.rafCallbacks,
        frozen.callbacksAtFreeze,
        'Native animation callbacks continued after freeze'
      );
      return frozen;
    }
    async function resume(): Promise<LifecycleSnapshot> {
      const before = await read();
      await restore();
      const resumed = await waitFor(
        read,
        (state) =>
          !state.hidden &&
          state.resumeEvents === before.resumeEvents + 1 &&
          state.visibleEvents === before.visibleEvents + 1
      );
      assert.equal(resumed.untrustedEvents, 0, 'Lifecycle events must come from Chromium');
      assert.equal(
        resumed.framesAtResume,
        resumed.framesAtFreeze,
        'Game callbacks ran while frozen'
      );
      assert.equal(
        resumed.callbacksAtResume,
        resumed.callbacksAtFreeze,
        'Native animation callbacks ran while frozen'
      );
      return resumed;
    }
    function pinDocument(): void {
      assert.equal(documentBaseline, undefined, 'Native document was already pinned');
      if (viteClientFailure !== undefined) {
        throw viteClientFailure;
      }
      assert.equal(viteClientResponses, 1, 'Native fixture must transform exactly one Vite client');
      documentBaseline = mainNavigations;
      recordHost('joined-document-pinned', null);
    }
    function assertDocumentSurvived(): void {
      assert(documentBaseline !== undefined, 'Native joined document is not pinned');
      assert.equal(
        mainNavigations,
        documentBaseline,
        'Native lifecycle navigated the joined document'
      );
      assert.equal(crashes, 0, 'Native renderer crashed');
      assert.equal(pageClosed, false, 'Native primary page closed');
      assert.equal(hmrSockets, 0, 'Native lifecycle fixture unexpectedly opened an HMR socket');
      assert.equal(viteClientResponses, 1, 'Native fixture reloaded its Vite client');
      assert.equal(viteClientFailure, undefined, 'Native Vite bootstrap transformation failed');
    }
    function markAutomaticRecovery(): void {
      assertDocumentSurvived();
      assert(lastObservation && !lastObservation.hidden && lastObservation.resumeEvents === 1);
      assert.equal(lastObservation.untrustedEvents, 0);
      recordHost('automatic-recovery-complete', null);
      freezeDeadline = 0;
    }
    function markExplicitReconnect(): void {
      assert(hostEvents.some((event) => event.kind === 'automatic-recovery-complete'));
      recordHost('explicit-reconnect-request', null);
    }
    function assertFreezeDiagnostics(
      diagnostic: { readonly errors: readonly string[]; readonly warnings: readonly string[] },
      expectedGameplayDisconnects: number
    ): void {
      assertDocumentSurvived();
      assert.equal(lastObservation?.freezeEvents, 1);
      assert.equal(lastObservation?.resumeEvents, 1);
      assert.equal(lastObservation?.untrustedEvents, 0);
      assert.equal(lastObservation?.callbacksAtFreeze, lastObservation?.callbacksAtResume);
      const freezeRequest = hostEvents.find((event) => event.kind === 'native-freeze-request');
      assert(freezeRequest, 'Missing native freeze command receipt');
      const automaticRecovery = hostEvents.find(
        (event) => event.kind === 'automatic-recovery-complete'
      );
      const explicitRequest = hostEvents.find(
        (event) => event.kind === 'explicit-reconnect-request'
      );
      assert(automaticRecovery && explicitRequest, 'Missing causal recovery boundaries');
      assert(automaticRecovery.atMs >= freezeRequest.atMs);
      assert(explicitRequest.atMs >= automaticRecovery.atMs);
      const socketUrl = (event: HostEvent): string | undefined =>
        event.data &&
        typeof event.data === 'object' &&
        'url' in event.data &&
        typeof event.data.url === 'string'
          ? event.data.url
          : undefined;
      const path = (url: string) => new URL(url).pathname;
      const socketId = (event: HostEvent): number | undefined =>
        event.data &&
        typeof event.data === 'object' &&
        'socketId' in event.data &&
        typeof event.data.socketId === 'number'
          ? event.data.socketId
          : undefined;
      const initialIds = new Set(
        hostEvents
          .filter((event) => event.kind === 'socket-created' && event.atMs <= freezeRequest.atMs)
          .map(socketId)
          .filter((id): id is number => id !== undefined)
      );
      const frozenCloses = hostEvents.filter(
        (event) =>
          event.kind === 'socket-close' &&
          event.freezeCycle === 1 &&
          event.atMs >= freezeRequest.atMs &&
          event.atMs <= automaticRecovery.atMs &&
          initialIds.has(socketId(event) ?? -1)
      );
      const frozenClosedUrls = new Set(
        frozenCloses.map(socketUrl).filter((url): url is string => url !== undefined)
      );
      assert.equal(frozenCloses.length, 2, 'Only the two original frozen transports may close');
      assert.deepEqual(
        [...frozenClosedUrls].map(path).sort((a, b) => a.localeCompare(b)),
        ['/logs', '/ws']
      );
      const gameplayCloses = hostEvents.filter(
        (event) =>
          event.kind === 'socket-close' &&
          socketUrl(event) !== undefined &&
          path(socketUrl(event) ?? '') === '/ws'
      );
      assert.equal(
        gameplayCloses.length,
        expectedGameplayDisconnects,
        'Unexpected gameplay socket closure count'
      );
      assert.equal(expectedGameplayDisconnects, 2, 'This scenario owns exactly two recoveries');
      const explicitCloses = gameplayCloses.filter((event) => event.atMs >= explicitRequest.atMs);
      assert.equal(explicitCloses.length, 1, 'Explicit recovery must close one distinct transport');
      const explicitClose = explicitCloses[0];
      assert(explicitClose);
      assert(!initialIds.has(socketId(explicitClose) ?? -1));
      let nativeErrors = 0;
      let gameplayErrors = 0;
      let logErrors = 0;
      let closureWarnings = 0;
      const nativeErrorUrls = new Set<string>();
      function observedDuringFreeze(text: string): boolean {
        return hostEvents.some(
          (event) =>
            event.kind === 'console' &&
            event.freezeCycle === 1 &&
            event.data &&
            typeof event.data === 'object' &&
            'text' in event.data &&
            event.data.text === safeNativeText(text)
        );
      }
      function applicationMessage(text: string):
        | {
            category?: unknown;
            message?: unknown;
            level?: unknown;
            source?: unknown;
            context?: unknown;
          }
        | undefined {
        try {
          const value: unknown = JSON.parse(text);
          return value && typeof value === 'object' ? value : undefined;
        } catch {
          return undefined;
        }
      }
      const unexpectedErrors: string[] = [];
      for (const text of diagnostic.errors) {
        const browserFailure =
          /^WebSocket connection to '([^']+)' failed: Page entered Back-Forward Cache\.$/u.exec(
            safeNativeText(text)
          );
        const failedUrl = browserFailure?.[1];
        if (failedUrl && frozenClosedUrls.has(failedUrl) && observedDuringFreeze(text)) {
          nativeErrors++;
          nativeErrorUrls.add(failedUrl);
          continue;
        }
        const record = applicationMessage(text);
        const error =
          record?.context && typeof record.context === 'object' && 'error' in record.context
            ? record.context.error
            : undefined;
        if (
          record?.source === 'client' &&
          record.level === 'error' &&
          record.category === 'NETWORK' &&
          record.message === 'WebSocket connection error' &&
          error &&
          typeof error === 'object' &&
          'message' in error &&
          error.message === 'WebSocket connection failed' &&
          observedDuringFreeze(text)
        ) {
          gameplayErrors++;
          continue;
        }
        if (
          /^\[LOG_FORWARD\] Log transport socket error; retaining queued records for reconnect(?: \{\}| Object| JSHandle@object)?$/u.test(
            text
          ) &&
          observedDuringFreeze(text)
        ) {
          logErrors++;
          continue;
        }
        unexpectedErrors.push(safeNativeText(text));
      }
      const unexpectedWarnings: string[] = [];
      for (const text of diagnostic.warnings) {
        const record = applicationMessage(text);
        if (
          record?.source === 'client' &&
          record.level === 'warn' &&
          record.category === 'NETWORK' &&
          record.message === 'WebSocket connection closed'
        ) {
          const warning = hostEvents.find(
            (event) =>
              event.kind === 'console' &&
              event.data &&
              typeof event.data === 'object' &&
              'text' in event.data &&
              event.data.text === safeNativeText(text)
          );
          assert(warning, 'Closure warning has no retained native console event');
          const command: HostEvent =
            warning.atMs <= automaticRecovery.atMs ? freezeRequest : explicitRequest;
          const replacement: HostEvent | undefined = hostEvents.find(
            (event) =>
              event.kind === 'socket-created' &&
              path(socketUrl(event) ?? '') === '/ws' &&
              event.atMs >= command.atMs
          );
          assert(replacement, 'Closure warning has no corresponding replacement transport');
          assert(warning.atMs >= command.atMs && warning.atMs <= replacement.atMs);
          closureWarnings++;
        } else {
          unexpectedWarnings.push(safeNativeText(text));
        }
      }
      assert.equal(
        nativeErrors,
        frozenClosedUrls.size,
        'Native failure count must match actually closed frozen sockets'
      );
      assert.equal(
        nativeErrorUrls.size,
        frozenClosedUrls.size,
        'Every frozen socket needs its exact native error'
      );
      assert.equal(gameplayErrors, 1, 'Native gameplay error must occur exactly once');
      assert.equal(logErrors, 1, 'Native log transport error must occur exactly once');
      assert.equal(
        closureWarnings,
        expectedGameplayDisconnects,
        'Application warnings must match actual closures'
      );
      assert.deepEqual(unexpectedErrors, [], 'Unexpected browser errors');
      assert.deepEqual(unexpectedWarnings, [], 'Unexpected browser warnings');
    }
    return {
      page,
      session,
      resize,
      observeGame,
      read,
      hideAndFreeze,
      resume,
      restore,
      close,
      diagnostics,
      pinDocument,
      assertDocumentSurvived,
      markAutomaticRecovery,
      markExplicitReconnect,
      assertFreezeDiagnostics,
    };
  } catch (error) {
    return withScenarioCleanup<never>(
      () => Promise.reject(error),
      () => close()
    );
  }
}
