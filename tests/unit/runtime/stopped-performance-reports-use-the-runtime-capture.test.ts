import { webcrypto } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { parseDebugReportSubmission } from '../../../shared/debugReports';
import { clientPerformance } from '../../../src/diagnostics/performanceMetrics';
import { storeResumeCredential } from '../../../src/network/services/resumeCredential';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { createGameRuntime, type GameRuntime } from '../../../src/runtime/gameRuntime';
import type { GamePresentation } from '../../../src/runtime/uiTypes';
import { installPhoneRecordingStorage } from '../../support/phoneRecordingStorage';

// Set the real feature flag before the metrics singleton and runtime are imported.
vi.hoisted(() =>
  window.history.replaceState(
    null,
    '',
    '/debug?performance=collect&scanScenery=cache&scanDetail=simple'
  )
);

// Logging transport is external to the runtime and recorder under test.
vi.mock('../../../src/utils/logForwarder', () => ({
  startClientLogForwarder: vi.fn(),
  stopClientLogForwarder: vi.fn(),
  forwardLogToServer: vi.fn(),
}));

let runtime: GameRuntime | undefined;
const scope = new AbortController();

afterEach(() => {
  runtime?.dispose();
  scope.abort();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('stopping the runtime recorder attaches a private, parseable performance summary to Send report', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('crypto', webcrypto);
  localStorage.setItem('soundOn', 'false');
  localStorage.setItem('musicOn', 'false');
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  installPhoneRecordingStorage();
  document.body.innerHTML =
    '<main id="gameWrapper"><div id="gameArea"><canvas id="gameCanvas"></canvas><canvas id="spawn-fly-in"></canvas></div><canvas id="title-terrain"></canvas></main>';
  const canvas = (id: string): HTMLCanvasElement => {
    const element = document.querySelector(`#${id}`);
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error(`Missing runtime canvas ${id}`);
    }
    return element;
  };
  runtime = createGameRuntime(
    {
      canvas: canvas('gameCanvas'),
      titleCanvas: canvas('title-terrain'),
      spawnCanvas: canvas('spawn-fly-in'),
      placeChrome: vi.fn(),
    },
    scope.signal
  );
  const views: GamePresentation[] = [];
  runtime.subscribe((view) => views.push(view));
  expect(views.at(-1)?.phone?.phase).toBe('ready');
  const nameCanary = 'TabletSecretPilot';
  const tokenCanary = 'bc'.repeat(32);
  storeResumeCredential(tokenCanary, nameCanary);
  runtime.commands.startPhoneCollection(`KFTUWI ${nameCanary}`, `Token canary ${tokenCanary}`);
  await vi.advanceTimersByTimeAsync(0);
  expect(views.at(-1)?.phone?.phase).toBe('recording');
  clientPerformance.setPhase('play');
  clientPerformance.recordFrameInterval(16, 16);
  canvasManager.easeZoomToward(0.25, 0);
  clientPerformance.setScanScene('enter');
  clientPerformance.record('simpleScanTerrainBuildMs', 2);
  clientPerformance.setSceneryFrame({ kind: 'built', cause: 'cold' });
  clientPerformance.recordVisibleSpiders(2);
  clientPerformance.recordFrameWork(1, 10, 11);
  clientPerformance.recordRendererFrame('canvas');
  await vi.advanceTimersByTimeAsync(1000);
  clientPerformance.recordFrameInterval(40, 56);
  canvasManager.easeZoomToward(0.25, 1000);
  clientPerformance.setScanScene('wide');
  clientPerformance.setSceneryFrame({ kind: 'cached' });
  clientPerformance.recordVisibleSpiders(3);
  clientPerformance.recordFrameWork(1, 4, 5);
  clientPerformance.recordRendererFrame('canvas');
  await vi.advanceTimersByTimeAsync(1000);
  clientPerformance.recordFrameInterval(30, 86);
  canvasManager.easeZoomToward(1, 1016);
  clientPerformance.setScanScene('return');
  clientPerformance.setSceneryFrame({ kind: 'built', cause: 'pan' });
  clientPerformance.recordVisibleSpiders(1);
  clientPerformance.recordFrameWork(1, 6, 7);
  clientPerformance.recordRendererFrame('canvas');
  await vi.advanceTimersByTimeAsync(1000);
  clientPerformance.recordFrameInterval(50, 136);
  canvasManager.easeZoomToward(1, 3016);
  runtime.commands.stopPhoneCollection();
  expect(views.at(-1)?.phone?.phase).toBe('stopped');
  const captured = runtime.commands.captureDiagnostics();
  const wire = JSON.stringify({
    version: 1,
    id: '12345678-1234-4123-8123-123456789abc',
    receiptToken: 'd'.repeat(64),
    description: 'Full glow tablet screening',
    submittedAt: new Date().toISOString(),
    diagnostics: captured,
  });
  expect(wire).not.toContain(nameCanary);
  expect(wire).not.toContain(tokenCanary);
  const parsed = parseDebugReportSubmission(JSON.parse(wire));
  expect(parsed.diagnostics.state['graphics']).toMatchObject({
    scanScenery: 'cache',
    sceneryCache: { scope: 'canvas-lifetime', ownedPixels: 0, peakOwnedPixels: 0, sourceRadius: 0 },
  });
  expect(parsed.diagnostics.state['metrics']).toMatchObject({
    performance: {
      complete: true,
      stopped: true,
      device: 'KFTUWI *',
      conditions: 'Token canary [redacted]',
      provenance: {
        graphics: {
          scanScenery: 'cache',
          scanSceneryMaxPixels: 8_000_000,
          deviceCategory: 'unknown',
          scanDetail: 'simple',
          scanDetailReason: 'forced-simple',
          scanDeviceMemory: 'unknown',
          scanLogicalCores: navigator.hardwareConcurrency || 'unknown',
          simpleScanDprCap: 0.75,
          simpleScanPixelCap: 1_000_000,
          simpleScanMaxDimension: 1536,
          presentationPolicy: 'visible-canvas-simple-scan-v1',
          flightEffectiveDpr: devicePixelRatio,
        },
      },
      observedPresentation: {
        values: expect.arrayContaining([
          expect.objectContaining({
            mode: 'simple-scan',
            stage: 'enter',
            backingWidth: Math.floor(innerWidth * 0.75),
            backingHeight: Math.floor(innerHeight * 0.75),
            dprX: Math.floor(innerWidth * 0.75) / innerWidth,
            dprY: Math.floor(innerHeight * 0.75) / innerHeight,
          }),
        ]),
      },
      metrics: {
        'play.simpleScanTerrainBuildMs': { count: 1, sum: 2 },
        'play.frameIntervalMs': { count: 4, sum: 136, p95: 50, p99: 50 },
        'play.scanFrameIntervalMs': { count: 3, sum: 120 },
        'play.scanEnterFrameIntervalMs': {
          count: 1,
          sum: 40,
          framesPerSecond: 25,
        },
        'play.scanWideFrameIntervalMs': { count: 1, sum: 30 },
        'play.scanReturnFrameIntervalMs': {
          count: 1,
          sum: 50,
          framesPerSecond: 20,
        },
      },
      slowFrameContext: {
        availability: 'complete',
        observedSlowIntervals: 3,
        values: [
          {
            intervalMs: 50,
            previousFrame: {
              stage: 'return',
              scenery: { kind: 'built', cause: 'pan' },
              visibleSpiders: 1,
            },
          },
          {
            intervalMs: 40,
            previousFrame: {
              stage: 'enter',
              scenery: { kind: 'built', cause: 'cold' },
              visibleSpiders: 2,
            },
          },
          {
            intervalMs: 30,
            previousFrame: {
              stage: 'wide',
              scenery: { kind: 'cached' },
              visibleSpiders: 3,
            },
          },
        ],
      },
    },
  });
});
