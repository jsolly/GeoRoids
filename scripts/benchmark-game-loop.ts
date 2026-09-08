import { performance } from 'node:perf_hooks';
import { type Browser, chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import type { WebSocket } from 'ws';
import { DEBUG, ROID, SATELLITE, SATELLITE_PICKUP } from '../src/constants';

const WARMUP_FRAMES = 180;
const MEASURED_BATCHES = 7;
const FRAMES_PER_BATCH = 120;
const FRAME_MS = 1000 / 60;
const VIEWPORT = { width: 1920, height: 1080 };

interface FixtureSize {
  humans: number;
  bots: number;
  asteroids: number;
  loot: number;
  satellites: number;
  satellitePickups: number;
}

interface Measurement {
  medianBatchMs: number;
  p95BatchMs: number;
  medianMsPerFrame: number;
}

interface BoundaryResult {
  before: FixtureSize;
  after: FixtureSize;
  measurement: Measurement;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] ?? 0;
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
    medianBatchMs,
    p95BatchMs: percentile(sorted, 0.95),
    medianMsPerFrame: medianBatchMs / FRAMES_PER_BATCH,
  };
}

function report(label: string, boundaries: Record<string, BoundaryResult>): void {
  console.log(`\n${label}`);
  for (const [boundary, result] of Object.entries(boundaries)) {
    console.log(`  ${boundary} fixture-before=${JSON.stringify(result.before)}`);
    console.log(`  ${boundary} fixture-after=${JSON.stringify(result.after)}`);
    console.log(
      `  ${boundary}: median=${result.measurement.medianMsPerFrame.toFixed(4)} ` +
        `ms/sync-frame (batch median=${result.measurement.medianBatchMs.toFixed(2)} ms, ` +
        `batch p95=${result.measurement.p95BatchMs.toFixed(2)} ms)`
    );
  }
}

async function measureClientFixture(
  page: Page,
  fixture: FixtureSize
): Promise<Record<string, BoundaryResult>> {
  return page.evaluate(
    async ({ fixture, frameMs, warmupFrames, measuredBatches, framesPerBatch }) => {
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
      const network = (
        gameController as unknown as {
          networkManager: {
            getAllPlayers: () => Array<typeof localPlayer>;
            getLocalPlayerId: () => string;
          };
        }
      ).networkManager;
      network.getAllPlayers = () => players;
      network.getLocalPlayerId = () => localPlayer.id;

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
          return sorted[Math.max(0, index)] ?? 0;
        };
        const medianBatchMs = at(0.5);
        return {
          medianBatchMs,
          p95BatchMs: at(0.95),
          medianMsPerFrame: medianBatchMs / framesPerBatch,
        };
      }

      configure();
      const updateBefore = counts();
      const updateMeasurement = browserMeasure(() => gameController.updateGame(frameMs));
      const updateAfter = counts();
      configure();
      const renderBefore = counts();
      const renderMeasurement = browserMeasure(() => gameController.renderGame());
      const renderAfter = counts();
      return {
        updateGame: { before: updateBefore, after: updateAfter, measurement: updateMeasurement },
        renderGame: { before: renderBefore, after: renderAfter, measurement: renderMeasurement },
      };
    },
    {
      fixture,
      frameMs: FRAME_MS,
      warmupFrames: WARMUP_FRAMES,
      measuredBatches: MEASURED_BATCHES,
      framesPerBatch: FRAMES_PER_BATCH,
    }
  );
}

async function measureBoundaryCulling(
  page: Page,
  fixture: FixtureSize
): Promise<Record<string, BoundaryResult>> {
  return page.evaluate(
    async ({ fixture, warmupFrames, measuredBatches, framesPerBatch }) => {
      const importBrowserModule = async <Module>(path: string): Promise<Module> =>
        (await import(/* @vite-ignore */ path)) as Module;
      const { drawFieryBoundary } = await importBrowserModule<
        typeof import('../src/rendering/boundaryRenderer')
      >('/src/rendering/boundaryRenderer.ts');
      const { canvasManager } = await importBrowserModule<typeof import('../src/rendering/canvas')>(
        '/src/rendering/canvas.ts'
      );
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
          return sorted[Math.max(0, index)] ?? 0;
        };
        const medianBatchMs = at(0.5);
        return {
          medianBatchMs,
          p95BatchMs: at(0.95),
          medianMsPerFrame: medianBatchMs / framesPerBatch,
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
  console.log('These synchronous batch timings are not animation FPS or GPU paint measurements.');

  const production: FixtureSize = {
    humans: 1,
    bots: DEBUG.BOT_PLAYER.COUNT,
    asteroids: ROID.INITIAL_ROID_COUNT,
    loot: 0,
    satellites: SATELLITE.AMBIENT_COUNT,
    satellitePickups: SATELLITE_PICKUP.MAX_COUNT,
  };
  const loaded: FixtureSize = {
    humans: 10,
    bots: DEBUG.BOT_PLAYER.COUNT,
    asteroids: ROID.INITIAL_ROID_COUNT * 4,
    loot: 15,
    satellites: SATELLITE.AMBIENT_COUNT,
    satellitePickups: SATELLITE_PICKUP.MAX_COUNT,
  };

  const vite = await createServer({
    clearScreen: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser: Browser | undefined;
  let page: Page | undefined;
  const clientFailures: unknown[] = [];
  try {
    await vite.listen();
    const clientUrl = vite.resolvedUrls?.local[0];
    if (!clientUrl) {
      throw new Error('Vite did not expose a local benchmark URL');
    }
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: VIEWPORT });
    await page.addInitScript(() => {
      // tsx preserves local helper names with this esbuild hook. Playwright
      // serializes evaluated functions without the module-level helper.
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
    for (const [fixtureName, fixture] of Object.entries({ production, loaded })) {
      report(
        `client ${fixtureName} @ ${VIEWPORT.width}x${VIEWPORT.height}`,
        await measureClientFixture(page, fixture)
      );
    }
    report(
      `client centered boundary subpath @ ${VIEWPORT.width}x${VIEWPORT.height}`,
      await measureBoundaryCulling(page, production)
    );
  } catch (error) {
    clientFailures.push(error);
  }
  const cleanupTasks = [
    ...(page ? [{ label: 'page', promise: page.close() }] : []),
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
    for (const [fixtureName, fixture] of Object.entries({ production, loaded })) {
      const result = await measureServerFixture(fixture, () => {
        simulatedNow += FRAME_MS;
      });
      report(`server ${fixtureName}`, { advanceOneFrame: result });
    }
  } finally {
    Date.now = originalDateNow;
  }
}

await main();
