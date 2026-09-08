import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { type Browser, type ConsoleMessage, chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import type { WebSocket } from 'ws';
import { DEBUG, ROID, SATELLITE, SATELLITE_PICKUP } from '../src/constants';

const WARMUP_FRAMES = 180;
const MEASURED_BATCHES = 7;
const FRAMES_PER_BATCH = 120;
const FRAME_MS = 1000 / 60;
const VIEWPORT = { width: 1920, height: 1080 };

export interface FixtureSize {
  humans: number;
  bots: number;
  asteroids: number;
  loot: number;
  satellites: number;
  satellitePickups: number;
}

export interface Measurement {
  batchMeansMs: number[];
  framesPerBatch: number;
  medianBatchMs: number;
  p95BatchMs: number;
  meanMsPerFrame: number;
  medianMsPerFrame: number;
  p95MsPerFrame: number;
}

export interface BoundaryResult {
  before: FixtureSize;
  after: FixtureSize;
  measurement: Measurement;
  environmentReads?: { safeAreaStyles: number; pointerMediaQueries: number };
}

export interface BenchmarkViewport {
  name: string;
  viewport: { width: number; height: number };
  hasTouch: boolean;
  safeAreaPadding: string;
}

export const BENCHMARK_VIEWPORTS: BenchmarkViewport[] = [
  { name: 'desktop', viewport: VIEWPORT, hasTouch: false, safeAreaPadding: '0px' },
  {
    name: 'touch-portrait',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    safeAreaPadding: '47px 0px 34px 0px',
  },
  {
    name: 'touch-landscape',
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    safeAreaPadding: '0px',
  },
];

export const CLIENT_FIXTURES: Record<string, FixtureSize> = {
  production: {
    humans: 1,
    bots: DEBUG.BOT_PLAYER.COUNT,
    asteroids: ROID.INITIAL_ROID_COUNT,
    loot: 0,
    satellites: SATELLITE.AMBIENT_COUNT,
    satellitePickups: SATELLITE_PICKUP.MAX_COUNT,
  },
  loaded: {
    humans: 10,
    bots: DEBUG.BOT_PLAYER.COUNT,
    asteroids: ROID.INITIAL_ROID_COUNT * 4,
    loot: 15,
    satellites: SATELLITE.AMBIENT_COUNT,
    satellitePickups: SATELLITE_PICKUP.MAX_COUNT,
  },
};

export interface ClientMeasurementOptions {
  includeUpdate?: boolean;
  warmupFrames?: number;
  measuredBatches?: number;
  framesPerBatch?: number;
}

async function withBrowserErrors<T>(page: Page, operation: () => Promise<T>): Promise<T> {
  const errors: string[] = [];
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  };
  const onPageError = (error: Error): void => {
    errors.push(error.message);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  try {
    const result = await operation();
    if (errors.length > 0) {
      throw new Error(`Browser benchmark failed:\n${errors.join('\n')}`);
    }
    return result;
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

/** Create the page in a context with the matching viewport and hasTouch setting. */
export async function initializeBenchmarkPage(
  page: Page,
  clientUrl: string,
  viewportCase: BenchmarkViewport
): Promise<void> {
  return withBrowserErrors(page, async () => {
    await page.addInitScript(() => {
      // tsx's helper is not included when Playwright serializes evaluated functions.
      Reflect.set(globalThis, '__name', (target: unknown) => target);
      let state = 42;
      Math.random = () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
      };
    });
    await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.gameController));
    await page.waitForFunction(({ width, height }) => {
      const canvas = document.getElementById('gameCanvas');
      return (
        canvas instanceof HTMLCanvasElement && canvas.width === width && canvas.height === height
      );
    }, viewportCase.viewport);
    await page.evaluate(async ({ hasTouch, safeAreaPadding }) => {
      const uiPath = '/src/ui/uiUtils.ts';
      const statePath = '/src/core/services/GameStateManager.ts';
      const networkPath = '/src/network/networkManager.ts';
      const ui: typeof import('../src/ui/uiUtils') = await import(/* @vite-ignore */ uiPath);
      const { GameStateManager }: typeof import('../src/core/services/GameStateManager') =
        await import(/* @vite-ignore */ statePath);
      const { NetworkManager }: typeof import('../src/network/networkManager') = await import(
        /* @vite-ignore */ networkPath
      );
      if (
        GameStateManager.getInstance().getIsGameRunning() ||
        NetworkManager.getInstance().isConnected
      ) {
        throw new Error(
          'Benchmark requires the game loop and network connection to remain stopped'
        );
      }
      ui.setPlayView(true);
      await document.fonts.ready;
      if (navigator.maxTouchPoints > 0 !== hasTouch) {
        throw new Error('Benchmark browser context does not match the requested touch capability');
      }
      const probe = document.getElementById('safe-area-probe');
      if (!(probe instanceof HTMLElement)) {
        throw new Error('Benchmark safe-area probe was not mounted');
      }
      probe.style.padding = safeAreaPadding;
      // Resolve the changed padding before any observation or timing begins.
      void getComputedStyle(probe).paddingTop;
      const canvas = document.getElementById('gameCanvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Benchmark canvas is missing');
      }
      const bounds = canvas.getBoundingClientRect();
      if (
        document.visibilityState !== 'visible' ||
        !canvas.checkVisibility() ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) {
        throw new Error('Benchmark requires a visible canvas with nonzero displayed dimensions');
      }
    }, viewportCase);
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  const value = sorted[Math.max(0, index)];
  if (value === undefined) {
    throw new Error('No measured batch available');
  }
  return value;
}

function measureFrames(runFrame: () => void): Measurement {
  for (let frame = 0; frame < WARMUP_FRAMES; frame++) {
    runFrame();
  }

  const batches: number[] = [];
  for (let batch = 0; batch < MEASURED_BATCHES; batch++) {
    const startedAt = performance.now();
    for (let frame = 0; frame < FRAMES_PER_BATCH; frame++) {
      runFrame();
    }
    batches.push(performance.now() - startedAt);
  }

  const sorted = batches.toSorted((left, right) => left - right);
  const medianBatchMs = percentile(sorted, 0.5);
  return {
    batchMeansMs: batches.map((duration) => duration / FRAMES_PER_BATCH),
    framesPerBatch: FRAMES_PER_BATCH,
    medianBatchMs,
    p95BatchMs: percentile(sorted, 0.95),
    meanMsPerFrame:
      batches.reduce((total, duration) => total + duration, 0) /
      (batches.length * FRAMES_PER_BATCH),
    medianMsPerFrame: medianBatchMs / FRAMES_PER_BATCH,
    p95MsPerFrame: percentile(sorted, 0.95) / FRAMES_PER_BATCH,
  };
}

function report(label: string, boundaries: Record<string, BoundaryResult>): void {
  console.log(`\n${label}`);
  for (const [boundary, result] of Object.entries(boundaries)) {
    console.log(`  ${boundary} fixture-before=${JSON.stringify(result.before)}`);
    console.log(`  ${boundary} fixture-after=${JSON.stringify(result.after)}`);
    if (result.environmentReads) {
      console.log(`  ${boundary} untimed-reads=${JSON.stringify(result.environmentReads)}`);
    }
    console.log(`  ${boundary} batch-means-ms=${JSON.stringify(result.measurement.batchMeansMs)}`);
    console.log(
      `  ${boundary}: arithmetic mean=${result.measurement.meanMsPerFrame.toFixed(4)}, ` +
        `median=${result.measurement.medianMsPerFrame.toFixed(4)} ` +
        `ms/sync-frame (batch median=${result.measurement.medianBatchMs.toFixed(2)} ms, ` +
        `p95 of batch means=${result.measurement.p95MsPerFrame.toFixed(4)} ms/sync-frame)`
    );
  }
}

export async function measureClientFixture(
  page: Page,
  fixture: FixtureSize,
  options: ClientMeasurementOptions = {}
): Promise<Record<string, BoundaryResult>> {
  const warmupFrames = options.warmupFrames ?? WARMUP_FRAMES;
  const measuredBatches = options.measuredBatches ?? MEASURED_BATCHES;
  const framesPerBatch = options.framesPerBatch ?? FRAMES_PER_BATCH;
  for (const [name, value] of Object.entries({ warmupFrames, measuredBatches, framesPerBatch })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (measuredBatches < MEASURED_BATCHES) {
    throw new Error(`At least ${MEASURED_BATCHES} measured batches are required`);
  }
  return withBrowserErrors(page, () =>
    page.evaluate(
      async ({
        fixture,
        frameMs,
        warmupFrames,
        measuredBatches,
        framesPerBatch,
        includeUpdate,
      }) => {
        // Vite serves these production modules to Chromium. TypeScript cannot
        // resolve browser-root module URLs while checking this Node script.
        const importBrowserModule = async <Module>(path: string): Promise<Module> =>
          (await import(/* @vite-ignore */ path)) as Module;
        const { entityFactory } = await importBrowserModule<
          typeof import('../src/entities/EntityFactory')
        >('/src/entities/EntityFactory.ts');
        const { Roid } = await importBrowserModule<typeof import('../src/entities/roid/Roid')>(
          '/src/entities/roid/Roid.ts'
        );
        const { LootField } = await importBrowserModule<
          typeof import('../src/entities/loot/LootField')
        >('/src/entities/loot/LootField.ts');
        const { SatelliteManager } = await importBrowserModule<
          typeof import('../src/entities/satellite/SatelliteManager')
        >('/src/entities/satellite/SatelliteManager.ts');
        const { SatellitePickupManager } = await importBrowserModule<
          typeof import('../src/entities/satellitePickup/SatellitePickupManager')
        >('/src/entities/satellitePickup/SatellitePickupManager.ts');
        const { satelliteProfileAt } =
          await importBrowserModule<typeof import('../shared/eoSatellites')>(
            '/shared/eoSatellites.ts'
          );
        const { NetworkManager } = await importBrowserModule<
          typeof import('../src/network/networkManager')
        >('/src/network/networkManager.ts');
        const { GameStateManager } = await importBrowserModule<
          typeof import('../src/core/services/GameStateManager')
        >('/src/core/services/GameStateManager.ts');
        const { canvasManager } = await importBrowserModule<
          typeof import('../src/rendering/canvas')
        >('/src/rendering/canvas.ts');
        const { hudLayoutForCanvas } = await importBrowserModule<
          typeof import('../src/rendering/hud/hudLayout')
        >('/src/rendering/hud/hudLayout.ts');
        const { drawScoreOverlay, drawTextOverlay } = await importBrowserModule<
          typeof import('../src/rendering/hud/gameInfo')
        >('/src/rendering/hud/gameInfo.ts');
        const { drawLivesIndicator } = await importBrowserModule<
          typeof import('../src/rendering/hud/lives')
        >('/src/rendering/hud/lives.ts');
        const { drawMiniMap } = await importBrowserModule<
          typeof import('../src/rendering/hud/minimap')
        >('/src/rendering/hud/minimap.ts');
        const { drawLeaderboard } = await importBrowserModule<
          typeof import('../src/rendering/hud/leaderboard')
        >('/src/rendering/hud/leaderboard.ts');
        const { PALETTE } =
          await importBrowserModule<typeof import('../src/constants')>('/src/constants/index.ts');

        const controller = window.gameController;
        if (!controller) {
          throw new Error('GameController did not initialize');
        }
        const gameController = controller;
        gameController.newGame('Benchmark Pilot', 'hauler');
        const local = gameController.getCurrPlayer();
        if (!local) {
          throw new Error('Benchmark local player was not created');
        }
        const localPlayer = local;
        localPlayer.id = 'benchmark-local';
        localPlayer.ship.position = { x: 0, y: 0 };
        localPlayer.ship.velocity = { x: 0, y: 0 };

        let players: Array<typeof localPlayer> = [localPlayer];
        const network = NetworkManager.getInstance();
        const originalGetAllPlayers = network.getAllPlayers;
        const originalGetLocalPlayerId = network.getLocalPlayerId;
        network.getAllPlayers = () => players;
        network.getLocalPlayerId = () => localPlayer.id;
        const gameState = GameStateManager.getInstance();
        const canvas = canvasManager.requireCanvas();
        const ctx = canvasManager.requireContext();

        function configure(): void {
          players = [localPlayer];
          for (let index = 1; index < fixture.humans; index++) {
            const angle = (index / fixture.humans) * Math.PI * 2;
            players.push(
              entityFactory.createRemotePlayer(
                `benchmark-remote-${index}`,
                `Remote ${index}`,
                { x: Math.cos(angle) * 500, y: Math.sin(angle) * 500 },
                '#55aaff'
              )
            );
          }
          for (let index = 0; index < fixture.bots; index++) {
            const angle = (index / Math.max(1, fixture.bots)) * Math.PI * 2;
            const bot = entityFactory.createBotPlayer(`Bot ${index}`, {
              x: Math.cos(angle) * 750,
              y: Math.sin(angle) * 750,
            });
            bot.id = `benchmark-bot-${index}`;
            players.push(bot);
          }

          const belt = gameController.getCurrRoidBelt();
          belt.roids.length = 0;
          for (let index = 0; index < fixture.asteroids; index++) {
            const angle = (index / fixture.asteroids) * Math.PI * 2;
            const ring = 900 + (index % 5) * 150;
            const asteroid = new Roid(
              { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring },
              15 + (index % 3) * 5,
              `benchmark-asteroid-${index}`
            );
            asteroid.velocity = { x: 0.08, y: -0.04 };
            asteroid.angularVelocity = 0.002;
            belt.roids.push(asteroid);
          }

          LootField.getInstance().applySnapshot(
            Array.from({ length: fixture.loot }, (_, index) => ({
              id: `benchmark-loot-${index}`,
              position: { x: 1000 + index * 12, y: 800 },
              mass: 1,
              radius: 4,
              kind: 'wreckage' as const,
            }))
          );
          SatelliteManager.getInstance().syncFromServer(
            Array.from({ length: fixture.satellites }, (_, index) => {
              const profile = satelliteProfileAt(index);
              const angle = (index / Math.max(1, fixture.satellites)) * Math.PI * 2;
              return {
                id: `benchmark-satellite-${index}`,
                name: profile.displayName,
                typeId: profile.typeId,
                assetKey: profile.assetKey,
                shotManner: profile.shotManner,
                position: { x: Math.cos(angle) * 1100, y: Math.sin(angle) * 1100 },
                velocity: { x: 0, y: 0 },
                angle,
                exploding: false,
                color: profile.hullColor,
                health: 100,
                maxHealth: 100,
                radius: 22,
              };
            })
          );
          SatellitePickupManager.getInstance().syncFromServer(
            Array.from({ length: fixture.satellitePickups }, (_, index) => ({
              id: `benchmark-pickup-${index}`,
              name: index % 2 === 0 ? ('Echo' as const) : ('Relay' as const),
              typeId: index % 2 === 0 ? ('echo' as const) : ('relay' as const),
              assetKey: index % 2 === 0 ? ('pickup/echo' as const) : ('pickup/relay' as const),
              position: { x: 950 + index * 80, y: -900 },
              velocity: { x: 0, y: 0 },
              angle: index * 0.3,
              radius: 15,
              color: '#99ffaa',
              state: 'loose' as const,
              ownerId: null,
              shieldFramesRemaining: 0,
            }))
          );
        }

        function counts(): FixtureSize {
          return {
            humans: players.filter((player) => player.type !== 'bot').length,
            bots: players.filter((player) => player.type === 'bot').length,
            asteroids: gameController.getCurrRoidCount(),
            loot: LootField.getInstance().getAll().length,
            satellites: SatelliteManager.getInstance().getAll().length,
            satellitePickups: SatellitePickupManager.getInstance().getAll().length,
          };
        }

        function browserMeasure(runFrame: () => void): Measurement {
          for (let frame = 0; frame < warmupFrames; frame++) {
            runFrame();
          }
          const batches: number[] = [];
          for (let batch = 0; batch < measuredBatches; batch++) {
            const startedAt = performance.now();
            for (let frame = 0; frame < framesPerBatch; frame++) {
              runFrame();
            }
            batches.push(performance.now() - startedAt);
          }
          const sorted = batches.toSorted((left, right) => left - right);
          const at = (fraction: number): number => {
            const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
            const value = sorted[Math.max(0, index)];
            if (value === undefined) {
              throw new Error('No measured batch available');
            }
            return value;
          };
          const medianBatchMs = at(0.5);
          return {
            batchMeansMs: batches.map((duration) => duration / framesPerBatch),
            framesPerBatch,
            medianBatchMs,
            p95BatchMs: at(0.95),
            meanMsPerFrame:
              batches.reduce((total, duration) => total + duration, 0) /
              (batches.length * framesPerBatch),
            medianMsPerFrame: medianBatchMs / framesPerBatch,
            p95MsPerFrame: at(0.95) / framesPerBatch,
          };
        }

        function observeEnvironmentReads(runFrame: () => void) {
          const reads = { safeAreaStyles: 0, pointerMediaQueries: 0 };
          const probe = document.getElementById('safe-area-probe');
          const originalStyle = window.getComputedStyle;
          const originalMedia = window.matchMedia;
          window.getComputedStyle = (element, pseudoElement) => {
            if (element === probe) {
              reads.safeAreaStyles++;
            }
            return originalStyle.call(window, element, pseudoElement);
          };
          window.matchMedia = (query) => {
            if (query === '(pointer: coarse)' || query === '(hover: none)') {
              reads.pointerMediaQueries++;
            }
            return originalMedia.call(window, query);
          };
          try {
            runFrame();
          } finally {
            window.getComputedStyle = originalStyle;
            window.matchMedia = originalMedia;
          }
          return reads;
        }

        function drawHud(): void {
          const layout = hudLayoutForCanvas(canvas);
          drawMiniMap(ctx, layout, localPlayer.ship);
          drawScoreOverlay(
            ctx,
            layout,
            canvas,
            localPlayer.score,
            localPlayer.lives,
            localPlayer.factionId
          );
          drawLivesIndicator(ctx, layout, localPlayer.lives, PALETTE.LOCAL, localPlayer.ship.kitId);
          const text = gameState.getText();
          const alpha = gameState.getTextAlpha();
          if (text && alpha > 0) {
            drawTextOverlay(ctx, layout, canvas, text, alpha);
          }
          if (players.length > 1) {
            drawLeaderboard(ctx, layout, players, localPlayer.id);
          }
        }

        const results: Record<string, BoundaryResult> = {};
        try {
          if (includeUpdate) {
            configure();
            const before = counts();
            const measurement = browserMeasure(() => gameController.updateGame(frameMs));
            results['updateGame'] = { before, after: counts(), measurement };
          }
          for (const overlay of [false, true]) {
            configure();
            gameState.clearOverlay();
            if (overlay) {
              gameState.updateTextProperties('Game Over: killed by Benchmark Rival', 1);
            }
            for (const [boundary, runFrame] of [
              ['renderGame', () => gameController.renderGame()],
              [
                'hud',
                () => {
                  canvasManager.clearPlayfield();
                  drawHud();
                },
              ],
            ] satisfies Array<[string, () => void]>) {
              const before = counts();
              const environmentReads = observeEnvironmentReads(runFrame);
              const measurement = browserMeasure(runFrame);
              const after = counts();
              for (const key of Object.keys(before)) {
                if (Reflect.get(before, key) !== Reflect.get(after, key)) {
                  throw new Error(`${boundary} changed fixture count ${key}`);
                }
              }
              results[`${boundary}${overlay ? 'Overlay' : ''}`] = {
                before,
                after,
                measurement,
                environmentReads,
              };
            }
          }
          return results;
        } finally {
          network.getAllPlayers = originalGetAllPlayers;
          network.getLocalPlayerId = originalGetLocalPlayerId;
          gameState.clearOverlay();
        }
      },
      {
        fixture,
        frameMs: FRAME_MS,
        warmupFrames,
        measuredBatches,
        framesPerBatch,
        includeUpdate: options.includeUpdate ?? true,
      }
    )
  );
}

async function measureBoundaryCulling(
  page: Page,
  fixture: FixtureSize
): Promise<Record<string, BoundaryResult>> {
  return withBrowserErrors(page, () =>
    page.evaluate(
      async ({ fixture, warmupFrames, measuredBatches, framesPerBatch }) => {
        const importBrowserModule = async <Module>(path: string): Promise<Module> =>
          (await import(/* @vite-ignore */ path)) as Module;
        const { drawFieryBoundary } = await importBrowserModule<
          typeof import('../src/rendering/boundaryRenderer')
        >('/src/rendering/boundaryRenderer.ts');
        const { canvasManager } = await importBrowserModule<
          typeof import('../src/rendering/canvas')
        >('/src/rendering/canvas.ts');
        const { getGameBoundary } = await importBrowserModule<
          typeof import('../src/physics/boundary')
        >('/src/physics/boundary.ts');
        const { PALETTE, VISUAL } =
          await importBrowserModule<typeof import('../src/constants')>('/src/constants/index.ts');

        const canvas = canvasManager.requireCanvas();
        const context = canvasManager.requireContext();
        const shipPosition = { x: 0, y: 0 };
        const boundary = getGameBoundary();

        const clear = (): void => {
          context.fillStyle = PALETTE.BG;
          context.fillRect(0, 0, canvas.width, canvas.height);
        };
        const drawLegacyReference = (): void => {
          const center = canvasManager.worldToScreen(
            { x: boundary.cx, y: boundary.cy },
            shipPosition
          );
          context.save();
          context.shadowColor = PALETTE.HUD_MUTED;
          context.shadowBlur = VISUAL.BOUNDARY_GLOW;
          context.strokeStyle = PALETTE.HUD_MUTED;
          context.lineWidth = VISUAL.BOUNDARY_STROKE_WIDTH;
          context.beginPath();
          context.arc(
            center.x,
            center.y,
            boundary.radius * canvasManager.getPlayfieldScale(),
            0,
            Math.PI * 2
          );
          context.stroke();
          context.restore();
        };
        const measure = (runFrame: () => void): Measurement => {
          for (let frame = 0; frame < warmupFrames; frame++) {
            runFrame();
          }
          const batches: number[] = [];
          for (let batch = 0; batch < measuredBatches; batch++) {
            const startedAt = performance.now();
            for (let frame = 0; frame < framesPerBatch; frame++) {
              runFrame();
            }
            batches.push(performance.now() - startedAt);
          }
          const sorted = batches.toSorted((left, right) => left - right);
          const at = (fraction: number): number => {
            const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
            const value = sorted[Math.max(0, index)];
            if (value === undefined) {
              throw new Error('No measured batch available');
            }
            return value;
          };
          const medianBatchMs = at(0.5);
          return {
            batchMeansMs: batches.map((duration) => duration / framesPerBatch),
            framesPerBatch,
            medianBatchMs,
            p95BatchMs: at(0.95),
            meanMsPerFrame:
              batches.reduce((total, duration) => total + duration, 0) /
              (batches.length * framesPerBatch),
            medianMsPerFrame: medianBatchMs / framesPerBatch,
            p95MsPerFrame: at(0.95) / framesPerBatch,
          };
        };

        const stableFixture = { ...fixture };
        const results = {
          currentCulled: {
            before: stableFixture,
            after: stableFixture,
            measurement: measure(() => {
              clear();
              drawFieryBoundary(shipPosition);
            }),
          },
          legacyReference: {
            before: stableFixture,
            after: stableFixture,
            measurement: measure(() => {
              clear();
              drawLegacyReference();
            }),
          },
        };

        // Readback can switch Chromium's canvas backing mode, so prove pixel
        // equivalence only after both command-submission timings are complete.
        clear();
        drawFieryBoundary(shipPosition);
        const currentPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        clear();
        drawLegacyReference();
        const referencePixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        if (
          currentPixels.length !== referencePixels.length ||
          currentPixels.some((value, index) => value !== referencePixels[index])
        ) {
          throw new Error('Boundary culling changed centered-camera pixels');
        }
        return results;
      },
      {
        fixture,
        warmupFrames: WARMUP_FRAMES,
        measuredBatches: MEASURED_BATCHES,
        framesPerBatch: FRAMES_PER_BATCH,
      }
    )
  );
}

async function measureServerFixture(
  fixture: FixtureSize,
  advanceClock: () => void
): Promise<BoundaryResult> {
  const { GameEngine } = await import('../server/core/GameEngine');
  const engine = new GameEngine(42);
  const socket = { close() {} } as unknown as WebSocket;
  engine.updatePauseState();
  for (let index = 0; index < fixture.humans; index++) {
    const angle = (index / fixture.humans) * Math.PI * 2;
    engine.addPlayer(
      `benchmark-human-${index}`,
      `Pilot ${index}`,
      socket,
      { x: Math.cos(angle) * 400, y: Math.sin(angle) * 400 },
      undefined,
      'dart'
    );
  }
  const missingAsteroids = fixture.asteroids - engine.getAsteroidCount();
  if (missingAsteroids > 0) {
    for (let index = 0; index < missingAsteroids; index++) {
      const angle = (index / missingAsteroids) * Math.PI * 2;
      const ring = 1400 + (index % 5) * 220;
      const radius = 15 + (index % 3) * 5;
      engine.addAsteroid({
        id: `benchmark-extra-asteroid-${index}`,
        position: { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring },
        velocity: { x: 0.08, y: -0.04 },
        size: radius,
        jaggedness: 0.25,
        rotation: angle,
        angularVelocity: 0.002,
        health: radius * 10,
        maxHealth: radius * 10,
        vertices: 8,
        offsets: [1, 0.9, 1.1, 0.95, 1.05, 0.92, 1.08, 0.98],
      });
    }
  }
  const internals = engine as unknown as {
    lootManager: { spawnShard(position: { x: number; y: number }, gameTime: number): unknown };
  };
  for (let index = 0; index < fixture.loot; index++) {
    internals.lootManager.spawnShard({ x: 2400 + index * 5, y: 2400 }, 0);
  }

  const counts = (): FixtureSize => {
    const diagnostics = engine.getDiagnostics();
    return {
      humans: diagnostics.humanPlayers,
      bots: diagnostics.bots,
      asteroids: diagnostics.asteroids,
      loot: diagnostics.loot,
      satellites: diagnostics.satellites,
      satellitePickups: diagnostics.satellitePickups,
    };
  };
  const before = counts();
  const measurement = measureFrames(() => {
    advanceClock();
    engine.advanceOneFrame();
  });
  return { before, after: counts(), measurement };
}

async function main(): Promise<void> {
  console.log('GeoRoids game-loop benchmark');
  console.log(
    `Chromium Canvas2D + Node simulation; ${WARMUP_FRAMES} warmup frames, ` +
      `${MEASURED_BATCHES} x ${FRAMES_PER_BATCH} measured synchronous frames.`
  );
  console.log('Client timings measure synchronous canvas submission, not FPS or GPU completion.');
  console.log(
    'Compare arithmetic means across all equal-sized batches: periodic canvas flushes can ' +
      'make median batch timings misleading when batches are bimodal.'
  );

  const vite = await createServer({
    clearScreen: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser: Browser | undefined;
  const clientFailures: unknown[] = [];
  try {
    await vite.listen();
    const clientUrl = vite.resolvedUrls?.local[0];
    if (!clientUrl) {
      throw new Error('Vite did not expose a local benchmark URL');
    }
    browser = await chromium.launch({ headless: true });
    for (const viewportCase of BENCHMARK_VIEWPORTS) {
      for (const [fixtureName, fixture] of Object.entries(CLIENT_FIXTURES)) {
        const context = await browser.newContext({
          viewport: viewportCase.viewport,
          hasTouch: viewportCase.hasTouch,
        });
        try {
          const page = await context.newPage();
          await initializeBenchmarkPage(page, clientUrl, viewportCase);
          report(
            `client ${fixtureName} ${viewportCase.name} @ ${viewportCase.viewport.width}x${viewportCase.viewport.height}`,
            await measureClientFixture(page, fixture, {
              includeUpdate: viewportCase.name === 'desktop',
            })
          );
          if (viewportCase.name === 'desktop' && fixtureName === 'production') {
            report(
              `client centered boundary subpath @ ${VIEWPORT.width}x${VIEWPORT.height}`,
              await measureBoundaryCulling(page, fixture)
            );
          }
        } finally {
          await context.close();
        }
      }
    }
  } catch (error) {
    clientFailures.push(error);
  }
  const cleanupTasks = [
    ...(browser ? [{ label: 'browser', promise: browser.close() }] : []),
    { label: 'Vite server', promise: vite.close() },
  ];
  const cleanupResults = await Promise.allSettled(cleanupTasks.map((task) => task.promise));
  for (const [index, result] of cleanupResults.entries()) {
    if (result.status === 'rejected') {
      clientFailures.push(
        new Error(`${cleanupTasks[index]?.label ?? 'unknown'} cleanup failed`, {
          cause: result.reason,
        })
      );
    }
  }
  if (clientFailures.length === 1) {
    throw clientFailures[0];
  }
  if (clientFailures.length > 1) {
    throw new AggregateError(clientFailures, 'Client benchmark or cleanup failed');
  }

  const originalDateNow = Date.now;
  let simulatedNow = 2_000_000_000_000;
  Date.now = () => simulatedNow;
  try {
    for (const [fixtureName, fixture] of Object.entries(CLIENT_FIXTURES)) {
      const result = await measureServerFixture(fixture, () => {
        simulatedNow += FRAME_MS;
      });
      report(`server ${fixtureName}`, { advanceOneFrame: result });
    }
  } finally {
    Date.now = originalDateNow;
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
