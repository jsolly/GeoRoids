import pageMarkup from '../../index.html?raw';
import '../../index.css';
import type { Position } from '../../shared-types';
import type { GpuContourLayer } from '../../src/rendering/gpuRearRenderer';
import type { StarPoint } from '../../src/rendering/nativeStarPainter';
import { createCompletedPixelCaptures } from './completed-pixel-captures';
import { traceNativePaint } from './gpu-native-paint-trace';

export const FROZEN_GPU_CHECKPOINTS = [
  'stationary',
  'scan-entry',
  'scan-easing',
  'scan-wide',
  'scan-return-easing',
  'scan-returned',
  'turn-45',
  'turn-90',
  'patch-crossing',
  'patch-crossing-turn-45',
  'patch-crossing-turn-90',
  'lit-furnace-combat',
  'connected-endpoints',
  'star-edges',
  'star-edges-scan',
  'star-edges-turn-45',
  'star-edges-scan-turn-90',
] as const;
type FrozenGpuCheckpoint = (typeof FROZEN_GPU_CHECKPOINTS)[number];

/** Independent capsule distance builds the allowed one-backing-pixel edge band. */
function contourMask(
  width: number,
  height: number,
  dpr: number,
  zoom: number,
  rotation: number,
  center: Position,
  layers: readonly GpuContourLayer[]
) {
  const edges = new Uint8Array(width * height);
  const interiors = new Uint8Array(width * height);
  const radius = (zoom * dpr) / 2;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const cssWidth = window.innerWidth;
  const cssHeight = window.innerHeight;
  const project = (x: number, y: number) => ({
    x: (cssWidth / 2 + ((x - center.x) * cosine - (y - center.y) * sine) * zoom) * dpr,
    y: (cssHeight / 2 + ((x - center.x) * sine + (y - center.y) * cosine) * zoom) * dpr,
  });
  for (const layer of layers) {
    for (const segment of layer.segments) {
      const a = project(segment.ax, segment.ay);
      const b = project(segment.bx, segment.by);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      const padding = radius + 1;
      const left = Math.max(0, Math.floor(Math.min(a.x, b.x) - padding));
      const right = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + padding));
      const top = Math.max(0, Math.floor(Math.min(a.y, b.y) - padding));
      const bottom = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + padding));
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const t =
            lengthSquared === 0
              ? 0
              : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared));
          const distance = Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
          const offset = y * width + x;
          if (Math.abs(distance - radius) <= 1) {
            edges[offset] = 1;
          }
          if (radius > 1 && distance < radius - 1) {
            interiors[offset] = 1;
          }
        }
      }
    }
  }
  return { edges, interiors };
}

function imageCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Frozen comparison canvas unavailable');
  }
  return { canvas, context };
}

/** No product event loop or transport runs in this deterministic rendering fixture. */
export async function createFrozenGpuScene() {
  const markup = new DOMParser().parseFromString(pageMarkup, 'text/html');
  for (const script of markup.querySelectorAll('script')) {
    script.remove();
  }
  document.body.innerHTML = markup.body.innerHTML;
  const originalUrl = location.href;
  const originalRandom = Math.random;
  const originalNow = Date.now;
  const performanceNowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let clock = 0;
  let random = 42;
  const pixelCaptures = createCompletedPixelCaptures();
  const readPixels = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number
  ) => {
    return pixelCaptures.capture(() => context.getImageData(x, y, width, height));
  };
  Math.random = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random / 2 ** 32;
  };
  Date.now = () => 1_700_000_000_000 + clock;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
  localStorage.setItem('soundOn', 'false');
  localStorage.setItem('musicOn', 'false');
  const { CAMERA, PALETTE, VISUAL } = await import('../../src/constants');
  const { Player } = await import('../../src/entities/player/Player');
  const { CLIENT_ID_STORAGE_KEY } = await import('../../src/network/services/clientIdentity');
  sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, 'frozen-local');
  const { GameController } = await import('../../src/core/gameController');
  const { GameStateManager } = await import('../../src/core/services/GameStateManager');
  const { NetworkManager } = await import('../../src/network/networkManager');
  const { MockPlayerInput } = await import('../../src/input/MockPlayerInput');
  const { Roid, RoidBelt } = await import('../../src/entities/roid/Roid');
  const { LootField } = await import('../../src/entities/loot/LootField');
  const { Laser } = await import('../../src/entities/laser/Laser');
  const { ensureTerrain } = await import('../../src/physics/terrain/terrainSession');
  const { setSpiderField } = await import('../../src/physics/terrain/spiderSession');
  const { resetWorldExploration, setWorldExploration, worldFurnaces } = await import(
    '../../src/network/worldExploration'
  );
  const { ExplorationMap } = await import('../../shared/exploration');
  const { CIVIC_LOTS } = await import('../../shared/furnaces');
  const { canvasManager } = await import('../../src/rendering/canvasSurface');
  const { paintOpaqueBackground } = await import('../../src/rendering/canvasBackground');
  const { GpuRearRenderer } = await import('../../src/rendering/gpuRearRenderer');
  const { drawGame, scanCameraZoom } = await import('../../src/rendering/canvas');
  const { drawContourLayers, drawIsoContours, visibleContourLayers } = await import(
    '../../src/rendering/contourRenderer'
  );
  const { drawStarfield, visibleStarTiles } = await import('../../src/rendering/starfield');
  const { hexToRgba } = await import('../../src/utils/colorUtils');
  const { setPlayView } = await import('../../src/ui/uiUtils');
  const originalFollowTravel = CAMERA.FOLLOW_TRAVEL;
  CAMERA.FOLLOW_TRAVEL = true;
  ensureTerrain(42);
  resetWorldExploration();
  const game = GameController.getInstance();
  if (
    GameStateManager.getInstance().getIsGameRunning() ||
    NetworkManager.getInstance().isConnected
  ) {
    throw new Error('Frozen fixture started live gameplay');
  }
  game.newGame('Frozen Scout', 'scout');
  const createdLocal = game.getCurrPlayer();
  if (!createdLocal) {
    throw new Error('Frozen local pilot missing');
  }
  const local = createdLocal;
  local.id = 'frozen-local';
  const remote = new Player({
    id: 'frozen-remote',
    name: 'Frozen Hauler',
    type: 'remote',
    input: new MockPlayerInput(),
    kitId: 'hauler',
  });
  for (const pilot of [local, remote]) {
    pilot.ship.blinkCount = 0;
    pilot.ship.blinkOn = false;
    pilot.ship.spawnProtectionTimer = 0;
    pilot.ship.id = `${pilot.id}-ship`;
    pilot.ship.thrusting = true;
  }
  const belt = new RoidBelt();
  for (let index = 0; index < 24; index++) {
    const angle = (index / 24) * Math.PI * 2;
    const radius = 180 + (index % 3) * 25;
    const roid = new Roid(
      { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
      5 + (index % 3) * 2,
      `frozen-rock-${index}`
    );
    roid.velocity = { x: 0, y: 0 };
    belt.roids.push(roid);
  }
  const rockOffsets = belt.roids.map((roid) => ({ ...roid.position }));
  setPlayView(true);
  await document.fonts.ready;
  const finish = () => {
    canvasManager.destroy();
    history.replaceState(null, '', originalUrl);
    setSpiderField(undefined);
    CAMERA.FOLLOW_TRAVEL = originalFollowTravel;
    Math.random = originalRandom;
    Date.now = originalNow;
    if (performanceNowDescriptor) {
      Object.defineProperty(performance, 'now', performanceNowDescriptor);
    } else {
      Reflect.deleteProperty(performance, 'now');
    }
  };

  async function capture(checkpoint: FrozenGpuCheckpoint) {
    clock = 0;
    const createdLot = CIVIC_LOTS[0];
    if (!createdLot) {
      throw new Error('Frozen furnace lot missing');
    }
    const lot = createdLot;
    const center = checkpoint.startsWith('patch-crossing')
      ? { x: 1025, y: 1025 }
      : checkpoint === 'lit-furnace-combat'
        ? { ...lot.position }
        : { x: 0, y: 0 };
    const explored = new ExplorationMap();
    explored.reveal(center, 2400);
    setWorldExploration(explored.snapshot());
    worldFurnaces.replaceLit([
      { id: lot.id, builderId: 'frozen-local', builderName: 'Frozen Scout' },
    ]);
    const rotation = checkpoint.endsWith('45')
      ? Math.PI / 4
      : checkpoint.endsWith('90')
        ? Math.PI / 2
        : 0;
    local.ship.position = { ...center };
    local.ship.velocity = {
      x: Math.cos(rotation + Math.PI / 2),
      y: -Math.sin(rotation + Math.PI / 2),
    };
    local.ship.angle = -(rotation + Math.PI / 2);
    remote.ship.position = { x: center.x + 115, y: center.y + 75 };
    remote.ship.angle = Math.PI / 6;
    for (const [index, roid] of belt.roids.entries()) {
      const offset = rockOffsets[index];
      if (offset) {
        roid.position = { x: center.x + offset.x, y: center.y + offset.y };
      }
    }
    const scanning =
      ['scan-entry', 'scan-easing', 'scan-wide'].includes(checkpoint) ||
      checkpoint.startsWith('star-edges-scan');
    local.ship.abilityActiveFrames = scanning ? 90 : 0;
    local.ship.lasers = [new Laser({ x: center.x + 40, y: center.y - 50 }, { x: 7, y: 2 }, 30, 0)];
    remote.ship.lasers = [
      new Laser({ x: center.x - 70, y: center.y + 30 }, { x: -5, y: 3 }, 50, 0),
    ];
    setSpiderField({
      nests: [],
      spiders: [
        {
          id: `frozen-spider-${checkpoint}`,
          position: { x: center.x - 125, y: center.y + 65 },
          angle: Math.PI / 7,
          health: 100,
          maxHealth: 100,
          phase: 'scuttling',
          targetId: null,
        },
      ],
    });
    LootField.getInstance().applySnapshot(
      Array.from({ length: 6 }, (_, index) => ({
        id: `frozen-loot-${index}`,
        position: { x: center.x - 90 + index * 35, y: center.y + 140 },
        mass: 1,
        radius: 4,
        kind: 'shard' as const,
      }))
    );
    const frameRandom = random;
    const gpuFrame = await renderBackend('webgl2');
    const canvasFrame = await renderBackend('canvas');
    const failureCheckpoint = [
      'stationary',
      'scan-easing',
      'scan-wide',
      'scan-return-easing',
    ].includes(checkpoint);
    const blitFailureFrame = failureCheckpoint ? await renderBackend('webgl2', 'blit') : null;
    const drawFailureFrame = failureCheckpoint ? await renderBackend('webgl2', 'upload') : null;
    const blitFailure = blitFailureFrame
      ? {
          backend: blitFailureFrame.backend,
          stats: blitFailureFrame.stats,
          injectedFailures: blitFailureFrame.injectedFailures,
          differingChannels: countDifferentChannels(canvasFrame.full, blitFailureFrame.full),
        }
      : null;
    const drawFailure = drawFailureFrame
      ? {
          backend: drawFailureFrame.backend,
          stats: drawFailureFrame.stats,
          injectedFailures: drawFailureFrame.injectedFailures,
          differingChannels: countDifferentChannels(canvasFrame.full, drawFailureFrame.full),
        }
      : null;
    if (gpuFrame.zoom !== canvasFrame.zoom || gpuFrame.rotation !== canvasFrame.rotation) {
      throw new Error('Frozen camera differs between backends');
    }
    const result = compare(
      checkpoint,
      center,
      canvasFrame.full,
      gpuFrame.full,
      gpuFrame.layers,
      gpuFrame.zoom,
      gpuFrame.rotation
    );
    const contourGeometryMatches =
      JSON.stringify(canvasFrame.layers) === JSON.stringify(gpuFrame.layers);
    const starCoverageDifferences = countDifferentChannels(
      canvasFrame.starCoverage.image,
      gpuFrame.starCoverage.image
    );
    const rearComparison = compare(
      checkpoint,
      center,
      canvasFrame.rear,
      gpuFrame.rear,
      gpuFrame.layers,
      gpuFrame.zoom,
      gpuFrame.rotation
    );
    const starCoverageFailures = result.firstFailures.map((failure) => {
      const read = (frame: typeof gpuFrame) =>
        Array.from(readPixels(frame.starCoverage.image.context, failure.x, failure.y, 1, 1).data);
      return {
        x: failure.x,
        y: failure.y,
        canvas: read(canvasFrame),
        webgl2: read(gpuFrame),
        rearCanvas: Array.from(
          readPixels(canvasFrame.rear.context, failure.x, failure.y, 1, 1).data
        ),
        rearWebgl2: Array.from(readPixels(gpuFrame.rear.context, failure.x, failure.y, 1, 1).data),
        nearestContour: nearestContour(
          failure.x,
          failure.y,
          center,
          gpuFrame.layers,
          gpuFrame.zoom,
          gpuFrame.rotation
        ),
        geometry: gpuFrame.starCoverage.geometry.filter(
          (star) =>
            failure.x >= Math.floor(star.native.left) - 1 &&
            failure.x <= Math.ceil(star.native.right) + 1 &&
            failure.y >= Math.floor(star.native.top) - 1 &&
            failure.y <= Math.ceil(star.native.bottom) + 1
        ),
      };
    });
    const supplemental =
      gpuFrame.supplemental && canvasFrame.supplemental
        ? compare(
            checkpoint,
            center,
            canvasFrame.supplemental,
            gpuFrame.supplemental,
            gpuFrame.syntheticLayers,
            gpuFrame.zoom,
            gpuFrame.rotation
          )
        : null;
    const samePixel = (a: readonly number[], b: readonly number[]) =>
      a.every((channel, index) => channel === b[index]);
    const brightnessDifferences = gpuFrame.witness.body.filter(
      (pixel, index) => !samePixel(pixel, canvasFrame.witness.body[index] ?? [])
    ).length;
    const missingRejected =
      gpuFrame.witness.omitted?.some(
        (pixel, index) => !samePixel(pixel, canvasFrame.witness.body[index] ?? [])
      ) ?? false;
    const doubledRejected =
      gpuFrame.witness.doubled?.some(
        (pixel, index) => !samePixel(pixel, canvasFrame.witness.body[index] ?? [])
      ) ?? false;
    const capPresent = gpuFrame.witness.caps.every(
      (pixel, index) =>
        (canvasFrame.witness.caps[index]?.[0] ?? 0) > 0 &&
        samePixel(pixel, canvasFrame.witness.caps[index] ?? [])
    );
    const buttCapsRejected =
      gpuFrame.witness.buttCaps?.every(
        (pixel, index) =>
          (canvasFrame.witness.caps[index]?.[0] ?? 0) > 0 &&
          !samePixel(pixel, canvasFrame.witness.caps[index] ?? [])
      ) ?? false;
    const nativeHairlineCapsRejected =
      gpuFrame.witness.stats?.contourMode !== 'canvas-path' ||
      (gpuFrame.witness.nativeHairlineCaps?.length === 2 &&
        gpuFrame.witness.nativeHairlineButtCaps?.length === 2 &&
        gpuFrame.witness.nativeHairlineCaps.every(
          (pixel, index) =>
            (pixel[0] ?? 0) > 0 &&
            samePixel(pixel, canvasFrame.witness.nativeHairlineCaps?.[index] ?? []) &&
            !samePixel(pixel, gpuFrame.witness.nativeHairlineButtCaps?.[index] ?? [])
        ));
    // These rerenders are diagnostics, never the qualification bitmap. Sampling
    // can flush native Canvas commands; report whether it changes either arm.
    const tracePoints = result.firstFailures.slice(0, 4).map(({ x, y }) => ({ x, y }));
    const nativePaintTrace =
      tracePoints.length > 0
        ? await (async () => {
            const tracedGpu = await renderBackend('webgl2', 'none', tracePoints);
            const tracedCanvas = await renderBackend('canvas', 'none', tracePoints);
            return {
              canvas: tracedCanvas.paintTrace,
              webgl2: tracedGpu.paintTrace,
              canvasInstrumentationDifferences: countDifferentChannels(
                canvasFrame.full,
                tracedCanvas.full
              ),
              webgl2InstrumentationDifferences: countDifferentChannels(
                gpuFrame.full,
                tracedGpu.full
              ),
            };
          })()
        : null;
    const isolatedPoint = rearComparison.firstFailures.find((failure) => failure.interior);
    const isolatedContourCoverage = isolatedPoint
      ? await (async () => {
          const isolatedGpu = await renderBackend('webgl2', 'none', [], isolatedPoint);
          const isolatedCanvas = await renderBackend('canvas', 'none', [], isolatedPoint);
          return { canvas: isolatedCanvas.contourIsolation, webgl2: isolatedGpu.contourIsolation };
        })()
      : null;
    return {
      ...result,
      blitFailure,
      drawFailure,
      starCoverageDifferences,
      starCoverageFailures,
      rear: {
        outsideDifferences: rearComparison.outsideDifferences,
        interiorDifferences: rearComparison.interiorDifferences,
        firstFailures: rearComparison.firstFailures,
      },
      contourGeometryMatches,
      nativePaintTrace,
      isolatedContourCoverage,
      starTransform: {
        canvas: canvasFrame.starCoverage.transform,
        webgl2: gpuFrame.starCoverage.transform,
      },
      renderer: gpuFrame.backend,
      canvasRenderer: canvasFrame.backend,
      stats: gpuFrame.stats,
      furnacePixels: { canvas: canvasFrame.furnacePixels, webgl2: gpuFrame.furnacePixels },
      supplemental: supplemental
        ? {
            outsideDifferences: supplemental.outsideDifferences,
            interiorDifferences: supplemental.interiorDifferences,
            allowedEdgeDifferences: supplemental.allowedEdgeDifferences,
            firstFailures: supplemental.firstFailures,
          }
        : null,
      witnesses: {
        brightnessDifferences,
        missingRejected,
        doubledRejected,
        capPresent,
        buttCapsRejected,
        nativeHairlineCapsRejected,
        canvas: canvasFrame.witness,
        webgl2: gpuFrame.witness,
      },
      images: {
        ...result.images,
        rearCanvas: rearComparison.images.canvas,
        rearWebgl2: rearComparison.images.webgl2,
        rearDifference: rearComparison.images.difference,
        starCoverageCanvas: canvasFrame.starCoverage.image.canvas.toDataURL('image/png'),
        starCoverageWebgl2: gpuFrame.starCoverage.image.canvas.toDataURL('image/png'),
        ...(blitFailureFrame
          ? { blitFailure: blitFailureFrame.full.canvas.toDataURL('image/png') }
          : {}),
        ...(drawFailureFrame
          ? { drawFailure: drawFailureFrame.full.canvas.toDataURL('image/png') }
          : {}),
        ...(supplemental
          ? {
              supplementalCanvas: supplemental.images.canvas,
              supplementalWebgl2: supplemental.images.webgl2,
              supplementalDifference: supplemental.images.difference,
              supplementalAllowedMask: supplemental.images.allowedMask,
            }
          : {}),
      },
    };

    async function renderBackend(
      backend: 'canvas' | 'webgl2',
      failure: 'none' | 'blit' | 'upload' = 'none',
      observedPoints: readonly { x: number; y: number }[] = [],
      contourPoint: { x: number; y: number } | null = null
    ) {
      const effectiveBackend = failure !== 'none' ? 'canvas' : backend;
      let injectedFailures = 0;
      let paintTrace: ReturnType<ReturnType<typeof traceNativePaint>['finish']> | null = null;
      canvasManager.destroy();
      const oldCanvas = document.querySelector('#gameCanvas');
      if (!(oldCanvas instanceof HTMLCanvasElement)) {
        throw new Error('Frozen playfield missing');
      }
      const freshCanvas = document.createElement('canvas');
      freshCanvas.id = 'gameCanvas';
      oldCanvas.replaceWith(freshCanvas);
      const url = new URL(location.href);
      url.searchParams.set('renderer', backend);
      history.replaceState(null, '', url);
      canvasManager.initialize();
      clock = 0;
      random = frameRandom;
      const target = scanCameraZoom(
        { ...local.ship, abilityActiveFrames: 90 },
        innerWidth,
        innerHeight
      );
      canvasManager.easeZoomToward(1, clock);
      const advanceZoom = (value: number, frames: number) => {
        for (let frame = 0; frame < frames; frame++) {
          clock += 1000 / 60;
          canvasManager.easeZoomToward(value, clock);
        }
      };
      if (checkpoint === 'scan-easing') {
        advanceZoom(target, 6);
      }
      if (checkpoint === 'scan-wide' || checkpoint.startsWith('star-edges-scan')) {
        advanceZoom(target, 120);
      }
      if (checkpoint === 'scan-return-easing' || checkpoint === 'scan-returned') {
        advanceZoom(target, 120);
        advanceZoom(1, checkpoint === 'scan-return-easing' ? 6 : 120);
      }
      return await new Promise<ReturnType<typeof copyFrame>>((resolve, reject) => {
        requestAnimationFrame(() => {
          const context = canvasManager.requireContext();
          const originalDrawImage = context.drawImage;
          const trace =
            observedPoints.length > 0
              ? traceNativePaint(context, observedPoints, (observation, width) =>
                  readPixels(observation, 0, 0, width, 1)
                )
              : null;
          const gpuCanvas = document.querySelector('#gameGpuCanvas');
          const gl =
            failure === 'upload' && gpuCanvas instanceof HTMLCanvasElement
              ? gpuCanvas.getContext('webgl2')
              : null;
          const originalUpload = gl?.texImage2D;
          if (failure === 'upload' && (!gl || !originalUpload)) {
            reject(new Error('Missing GPU source-upload failure boundary'));
            return;
          }
          if (gl && originalUpload) {
            gl.texImage2D = new Proxy(originalUpload, {
              apply(targetFunction, receiver, argumentsList) {
                const uploadResult: unknown = Reflect.apply(
                  targetFunction,
                  receiver,
                  argumentsList
                );
                const source: unknown = argumentsList[5];
                if (
                  source instanceof HTMLCanvasElement &&
                  source.id === 'gameCanvas' &&
                  injectedFailures === 0
                ) {
                  injectedFailures++;
                  throw new Error('Injected failure after native source upload');
                }
                return uploadResult;
              },
            });
          }
          if (failure === 'blit') {
            context.drawImage = new Proxy(originalDrawImage, {
              apply(targetFunction, receiver, argumentsList) {
                const source = argumentsList[0];
                if (
                  source instanceof HTMLCanvasElement &&
                  source.id === 'gameGpuCanvas' &&
                  injectedFailures === 0
                ) {
                  injectedFailures++;
                  throw new Error('Injected rear composition failure');
                }
                return Reflect.apply(targetFunction, receiver, argumentsList);
              },
            });
          }
          try {
            drawGame(local, belt, 1234, 1, 'Frozen rendering comparison', [local, remote]);
            paintTrace = trace?.finish() ?? null;
            context.drawImage = originalDrawImage;
            if (gl && originalUpload) {
              gl.texImage2D = originalUpload;
            }
            resolve(copyFrame());
          } catch (error) {
            reject(error);
          } finally {
            if (trace && !paintTrace) {
              trace.finish();
            }
            context.drawImage = originalDrawImage;
            if (gl && originalUpload) {
              gl.texImage2D = originalUpload;
            }
          }
        });
      });

      function copyFrame() {
        const overlay = canvasManager.requireCanvas();
        const ctx = canvasManager.requireContext();
        const actualBackend = canvasManager.getRendererBackend();
        if (actualBackend !== effectiveBackend) {
          throw new Error(`Frozen ${backend} scene used ${actualBackend}`);
        }
        const full = imageCanvas(overlay.width, overlay.height);
        const gpu = document.querySelector('#gameGpuCanvas');
        if (effectiveBackend === 'webgl2') {
          if (!(gpu instanceof HTMLCanvasElement)) {
            throw new Error('GPU bitmap missing');
          }
          full.context.drawImage(gpu, 0, 0);
        }
        full.context.drawImage(overlay, 0, 0);
        const stats = canvasManager.getGpuFrameStats();
        let furnacePixels = 0;
        if (checkpoint === 'lit-furnace-combat') {
          worldFurnaces.replaceLit([]);
          try {
            random = frameRandom;
            drawGame(local, belt, 1234, 1, 'Frozen rendering comparison', [local, remote]);
            const dark = imageCanvas(overlay.width, overlay.height);
            if (effectiveBackend === 'webgl2' && gpu instanceof HTMLCanvasElement) {
              dark.context.drawImage(gpu, 0, 0);
            }
            dark.context.drawImage(overlay, 0, 0);
            const left = Math.floor((innerWidth / 2 - 60) * devicePixelRatio);
            const top = Math.floor((innerHeight / 2 - 60) * devicePixelRatio);
            const size = Math.floor(120 * devicePixelRatio);
            const litPixels = readPixels(full.context, left, top, size, size).data;
            const darkPixels = readPixels(dark.context, left, top, size, size).data;
            for (let offset = 0; offset < litPixels.length; offset += 4) {
              if (
                (litPixels[offset] ?? 0) > (darkPixels[offset] ?? 0) + 5 ||
                (litPixels[offset + 1] ?? 0) > (darkPixels[offset + 1] ?? 0) + 5
              ) {
                furnacePixels++;
              }
            }
          } finally {
            worldFurnaces.replaceLit([
              { id: lot.id, builderId: 'frozen-local', builderName: 'Frozen Scout' },
            ]);
          }
        }
        canvasManager.beginWorldLayers(ctx);
        const zoom = ctx.getTransform().a / devicePixelRatio;
        const cameraRotation = canvasManager.getCameraRotation();
        const layers = visibleContourLayers(center);
        let syntheticLayers: readonly GpuContourLayer[] = [];
        let edgeStars: StarPoint[] | null = null;
        if (checkpoint === 'connected-endpoints') {
          const origin = { x: center.x + 70, y: center.y - 70 };
          syntheticLayers = [
            {
              index: 1,
              segments: [
                { ax: origin.x - 40, ay: origin.y, bx: origin.x, by: origin.y },
                { ax: origin.x, ay: origin.y, bx: origin.x + 40, by: origin.y },
                { ax: origin.x, ay: origin.y - 30, bx: origin.x, by: origin.y + 30 },
                { ax: origin.x, ay: origin.y, bx: origin.x, by: origin.y },
              ],
            },
          ];
        }
        if (checkpoint.startsWith('star-edges')) {
          const viewport = canvasManager.getViewportSize();
          const cosine = Math.cos(cameraRotation);
          const sine = Math.sin(cameraRotation);
          const offsets = [-1.2, -1, -0.8, 0.8, 1.2];
          edgeStars = offsets
            .flatMap((offset, index) => [
              { x: index < 3 ? offset : viewport.width + offset, y: 12 + index * 15 },
              { x: 12 + index * 15, y: index < 3 ? offset : viewport.height + offset },
            ])
            .map((star) => {
              const dx = star.x - viewport.width / 2;
              const dy = star.y - viewport.height / 2;
              return {
                x: center.x + dx * cosine + dy * sine,
                y: center.y - dx * sine + dy * cosine,
                alpha: 0.53,
              };
            });
        }
        canvasManager.endWorldLayers(ctx);
        let supplementalImage: ReturnType<typeof imageCanvas> | null = null;
        if (checkpoint === 'connected-endpoints' || edgeStars) {
          supplementalImage = imageCanvas(overlay.width, overlay.height);
          if (effectiveBackend === 'webgl2') {
            canvasManager.beginWorldLayers(ctx);
            try {
              if (
                !canvasManager.drawGpuRear({
                  position: center,
                  contours: syntheticLayers,
                  starTiles: edgeStars ? [edgeStars] : [],
                }) ||
                !(gpu instanceof HTMLCanvasElement)
              ) {
                throw new Error('Synthetic GPU rear scene did not draw');
              }
              if (!canvasManager.composeGpuRear(ctx)) {
                throw new Error('Synthetic GPU rear scene did not compose');
              }
              if (canvasManager.requiresNativeGpuContours()) {
                canvasManager.recordNativeGpuContours(drawContourLayers(center, syntheticLayers));
              }
              supplementalImage.context.drawImage(overlay, 0, 0);
            } finally {
              canvasManager.endWorldLayers(ctx);
            }
          } else {
            paintOpaqueBackground(ctx);
            canvasManager.beginWorldLayers(ctx);
            try {
              if (edgeStars) {
                const viewport = canvasManager.getViewportSize();
                for (const star of edgeStars) {
                  const screen = canvasManager.worldToScreen(star, center);
                  if (
                    screen.x < -VISUAL.STAR_SIZE ||
                    screen.y < -VISUAL.STAR_SIZE ||
                    screen.x > viewport.width + VISUAL.STAR_SIZE ||
                    screen.y > viewport.height + VISUAL.STAR_SIZE
                  ) {
                    continue;
                  }
                  ctx.fillStyle = hexToRgba(PALETTE.STARS, star.alpha);
                  ctx.fillRect(
                    (screen.x + 0.5) | 0,
                    (screen.y + 0.5) | 0,
                    VISUAL.STAR_SIZE,
                    VISUAL.STAR_SIZE
                  );
                }
              } else {
                ctx.save();
                canvasManager.applyWorldTransform(ctx, center);
                ctx.lineWidth = VISUAL.CONTOUR_STROKE_WIDTH;
                ctx.lineCap = 'round';
                ctx.strokeStyle = hexToRgba(PALETTE.CONTOUR, VISUAL.CONTOUR_ALPHA);
                ctx.beginPath();
                for (const layer of syntheticLayers) {
                  for (const segment of layer.segments) {
                    ctx.moveTo(segment.ax, segment.ay);
                    ctx.lineTo(segment.bx, segment.by);
                  }
                }
                ctx.stroke();
                ctx.restore();
              }
            } finally {
              canvasManager.endWorldLayers(ctx);
            }
            supplementalImage.context.drawImage(overlay, 0, 0);
          }
        }
        const rear = observeRearScene(effectiveBackend, center);
        const starCoverage = observeGeneratedStarCoverage(effectiveBackend, center);
        const witness = contourWitness(effectiveBackend, center, zoom, cameraRotation);
        const contourIsolation = contourPoint
          ? isolateContourCoverage(
              effectiveBackend,
              center,
              layers,
              zoom,
              cameraRotation,
              contourPoint
            )
          : null;
        return {
          full,
          supplemental: supplementalImage,
          layers,
          syntheticLayers,
          zoom,
          rotation: cameraRotation,
          backend: actualBackend,
          stats,
          witness,
          starCoverage,
          rear,
          furnacePixels,
          injectedFailures,
          paintTrace,
          contourIsolation,
        };
      }
    }
  }

  /** Diagnose the real path at an interior failure without changing qualification
   * geometry: compare one segment, overlapping neighbors and its entire level. */
  function isolateContourCoverage(
    backend: 'canvas' | 'webgl2',
    center: Position,
    layers: readonly GpuContourLayer[],
    zoom: number,
    rotation: number,
    point: { x: number; y: number }
  ) {
    let selected: {
      layer: GpuContourLayer;
      segment: GpuContourLayer['segments'][number];
      distance: number;
    } | null = null;
    for (const layer of layers) {
      for (const segment of layer.segments) {
        const distance = nearestContour(
          point.x,
          point.y,
          center,
          [{ index: layer.index, segments: [segment] }],
          zoom,
          rotation
        ).closest?.distance;
        if (distance !== undefined && (!selected || distance < selected.distance)) {
          selected = { layer, segment, distance };
        }
      }
    }
    if (!selected) {
      throw new Error('Isolated contour witness has no native segment');
    }
    const chosen = selected;
    const radius = (zoom * devicePixelRatio * VISUAL.CONTOUR_STROKE_WIDTH) / 2;
    const neighbors = chosen.layer.segments.filter((segment) => {
      const distance = nearestContour(
        point.x,
        point.y,
        center,
        [{ index: chosen.layer.index, segments: [segment] }],
        zoom,
        rotation
      ).closest?.distance;
      return distance !== undefined && distance <= radius + 2;
    });
    const ctx = canvasManager.requireContext();
    const overlay = canvasManager.requireCanvas();
    const sample = (segments: GpuContourLayer['segments'], forceNativeButt = false) => {
      paintOpaqueBackground(ctx);
      canvasManager.beginWorldLayers(ctx);
      try {
        const contours = [{ index: chosen.layer.index, segments }];
        const gpu = backend === 'webgl2' && !forceNativeButt;
        if (
          gpu &&
          (!canvasManager.drawGpuRear({ position: center, contours, starTiles: [] }) ||
            !canvasManager.composeGpuRear(ctx))
        ) {
          throw new Error('Isolated contour GPU draw failed');
        }
        if (!gpu || canvasManager.requiresNativeGpuContours()) {
          const originalStroke = ctx.stroke;
          try {
            if (forceNativeButt) {
              ctx.stroke = new Proxy(originalStroke, {
                apply(target, receiver, argumentsList) {
                  ctx.lineCap = 'butt';
                  return Reflect.apply(target, receiver, argumentsList);
                },
              });
            }
            const submitted = drawContourLayers(center, contours);
            if (gpu) {
              canvasManager.recordNativeGpuContours(submitted);
            }
          } finally {
            ctx.stroke = originalStroke;
          }
        }
        const image = imageCanvas(3, 3);
        image.context.drawImage(overlay, point.x - 1, point.y - 1, 3, 3, 0, 0, 3, 3);
        return {
          pixels: Array.from(readPixels(image.context, 0, 0, 3, 3).data),
          submitted: segments.length,
          stats: gpu ? canvasManager.getGpuFrameStats() : null,
        };
      } finally {
        canvasManager.endWorldLayers(ctx);
      }
    };
    return {
      point,
      index: chosen.layer.index,
      segment: chosen.segment,
      projected: nearestContour(
        point.x,
        point.y,
        center,
        [{ index: chosen.layer.index, segments: [chosen.segment] }],
        zoom,
        rotation
      ),
      single: sample([chosen.segment]),
      neighbors: sample(neighbors),
      fullLevel: sample(chosen.layer.segments),
      nativeButt: sample([chosen.segment], true),
    };
  }

  function observeRearScene(backend: 'canvas' | 'webgl2', center: Position) {
    const ctx = canvasManager.requireContext();
    const overlay = canvasManager.requireCanvas();
    const image = imageCanvas(overlay.width, overlay.height);
    paintOpaqueBackground(ctx);
    canvasManager.beginWorldLayers(ctx);
    try {
      if (backend === 'webgl2') {
        if (
          !canvasManager.drawGpuRear({
            position: center,
            contours: visibleContourLayers(center),
            starTiles: visibleStarTiles(center),
          })
        ) {
          throw new Error('Colored rear GPU draw failed');
        }
        const source = document.querySelector('#gameGpuCanvas');
        if (!(source instanceof HTMLCanvasElement)) {
          throw new Error('Colored rear GPU bitmap missing');
        }
        if (!canvasManager.composeGpuRear(ctx)) {
          throw new Error('Colored GPU rear scene did not compose');
        }
        if (canvasManager.requiresNativeGpuContours()) {
          canvasManager.recordNativeGpuContours(drawIsoContours(center));
        }
        image.context.drawImage(overlay, 0, 0);
      } else {
        drawStarfield(center);
        drawIsoContours(center);
        image.context.drawImage(overlay, 0, 0);
      }
      return image;
    } finally {
      canvasManager.endWorldLayers(ctx);
    }
  }

  function nearestContour(
    x: number,
    y: number,
    center: Position,
    layers: readonly GpuContourLayer[],
    zoom: number,
    rotation: number
  ) {
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    const project = (wx: number, wy: number) => ({
      x:
        (innerWidth / 2 + ((wx - center.x) * cosine - (wy - center.y) * sine) * zoom) *
        devicePixelRatio,
      y:
        (innerHeight / 2 + ((wx - center.x) * sine + (wy - center.y) * cosine) * zoom) *
        devicePixelRatio,
    });
    let closest: { index: number; distance: number; a: Position; b: Position } | null = null;
    for (const layer of layers) {
      for (const segment of layer.segments) {
        const a = project(segment.ax, segment.ay);
        const b = project(segment.bx, segment.by);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const squared = dx * dx + dy * dy;
        const t =
          squared === 0
            ? 0
            : Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / squared));
        const distance = Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy);
        if (!closest || distance < closest.distance) {
          closest = { index: layer.index, distance, a, b };
        }
      }
    }
    return { radius: (zoom * devicePixelRatio) / 2, closest };
  }

  function observeGeneratedStarCoverage(backend: 'canvas' | 'webgl2', center: Position) {
    const overlay = canvasManager.requireCanvas();
    const ctx = canvasManager.requireContext();
    const image = imageCanvas(overlay.width, overlay.height);
    paintOpaqueBackground(ctx);
    canvasManager.beginWorldLayers(ctx);
    try {
      const matrix = ctx.getTransform();
      const viewport = canvasManager.getViewportSize();
      const zoomInput = innerWidth / viewport.width;
      const tiles = visibleStarTiles(center);
      const f = Math.fround;
      const zoomFloat = f(zoomInput);
      const geometry: {
        x: number;
        y: number;
        alpha: number;
        uploadedAlpha: number;
        snapped: { x: number; y: number };
        native: { left: number; top: number; right: number; bottom: number };
        gpuFloat: { left: number; top: number; right: number; bottom: number };
      }[] = [];
      ctx.fillStyle = '#ffffff';
      for (const tile of tiles) {
        const anchor = tile[0];
        if (!anchor) {
          continue;
        }
        for (const star of tile) {
          const screen = canvasManager.worldToScreen(star, center);
          if (
            screen.x < -VISUAL.STAR_SIZE ||
            screen.y < -VISUAL.STAR_SIZE ||
            screen.x > viewport.width + VISUAL.STAR_SIZE ||
            screen.y > viewport.height + VISUAL.STAR_SIZE
          ) {
            continue;
          }
          const sx = (screen.x + 0.5) | 0;
          const sy = (screen.y + 0.5) | 0;
          ctx.fillRect(sx, sy, VISUAL.STAR_SIZE, VISUAL.STAR_SIZE);
          const left = f(sx * f(matrix.a) + f(matrix.e));
          const top = f(sy * f(matrix.d) + f(matrix.f));
          const right = f((sx + VISUAL.STAR_SIZE) * f(matrix.a) + f(matrix.e));
          const bottom = f((sy + VISUAL.STAR_SIZE) * f(matrix.d) + f(matrix.f));
          geometry.push({
            x: star.x,
            y: star.y,
            alpha: star.alpha,
            uploadedAlpha: f(Math.round(star.alpha * 100) / 100),
            snapped: { x: sx, y: sy },
            native: {
              left: f(sx * f(matrix.a) + f(matrix.e)),
              top: f(sy * f(matrix.d) + f(matrix.f)),
              right: f((sx + VISUAL.STAR_SIZE) * f(matrix.a) + f(matrix.e)),
              bottom: f((sy + VISUAL.STAR_SIZE) * f(matrix.d) + f(matrix.f)),
            },
            gpuFloat: { left, top, right, bottom },
          });
        }
      }
      const transform = {
        a: matrix.a,
        d: matrix.d,
        e: matrix.e,
        f: matrix.f,
        zoomInput,
        zoomFloat,
      };
      if (backend === 'webgl2') {
        const source = document.querySelector('#gameGpuCanvas');
        if (!(source instanceof HTMLCanvasElement)) {
          throw new Error('Generated-star coverage GPU canvas missing');
        }
        const originalFillRect = ctx.fillRect;
        try {
          ctx.fillRect = new Proxy(originalFillRect, {
            apply(targetFunction, receiver, argumentsList) {
              if (argumentsList[2] === VISUAL.STAR_SIZE && argumentsList[3] === VISUAL.STAR_SIZE) {
                ctx.fillStyle = '#ffffff';
              }
              return Reflect.apply(targetFunction, receiver, argumentsList);
            },
          });
          if (
            !canvasManager.drawGpuRear({
              position: center,
              contours: [],
              starTiles: tiles.map((tile) => tile.map((star) => ({ ...star, alpha: 1 }))),
            })
          ) {
            throw new Error('Generated-star coverage GPU draw failed');
          }
          image.context.drawImage(source, 0, 0);
        } finally {
          ctx.fillRect = originalFillRect;
        }
      } else {
        image.context.drawImage(overlay, 0, 0);
      }
      return { image, transform, geometry };
    } finally {
      canvasManager.endWorldLayers(ctx);
    }
  }

  function countDifferentChannels(
    left: ReturnType<typeof imageCanvas>,
    right: ReturnType<typeof imageCanvas>
  ): number {
    const reference = readPixels(left.context, 0, 0, left.canvas.width, left.canvas.height).data;
    const actual = readPixels(right.context, 0, 0, right.canvas.width, right.canvas.height).data;
    let differences = 0;
    for (let index = 0; index < reference.length; index++) {
      if (reference[index] !== actual[index]) {
        differences++;
      }
    }
    return differences;
  }

  function setVisual(key: 'CONTOUR_ALPHA' | 'CONTOUR_STROKE_WIDTH', value: number) {
    if (!Reflect.set(VISUAL, key, value)) {
      throw new Error(`Frozen witness cannot change ${key}`);
    }
  }

  /** Backing-pixel-aligned straight interiors forbid brightness changes at every DPR/zoom.
   * Endpoint samples separately reject lost round caps. Mutation samples run the real GPU
   * boundary with absent contours and doubled alpha; neither can hide in the edge mask. */
  function contourWitness(
    backend: 'canvas' | 'webgl2',
    center: Position,
    zoom: number,
    rotation: number
  ) {
    const overlay = canvasManager.requireCanvas();
    const ctx = canvasManager.requireContext();
    const dpr = devicePixelRatio;
    const x = Math.floor(overlay.width / 2) + 0.5;
    const y = Math.floor(overlay.height / 2) + 0.5;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    const world = (px: number, py: number) => {
      const dx = (px / dpr - innerWidth / 2) / zoom;
      const dy = (py / dpr - innerHeight / 2) / zoom;
      return { x: center.x + dx * cosine + dy * sine, y: center.y - dx * sine + dy * cosine };
    };
    const a = world(x - 24, y);
    const b = world(x + 24, y);
    const layers = [{ index: 1, segments: [{ ax: a.x, ay: a.y, bx: b.x, by: b.y }] }];
    const sample = (
      contours: readonly GpuContourLayer[],
      cap: CanvasLineCap = 'round',
      forceCanvas = false,
      capOffset = 24
    ) => {
      paintOpaqueBackground(ctx);
      canvasManager.beginWorldLayers(ctx);
      try {
        const gpu = backend === 'webgl2' && !forceCanvas;
        if (gpu) {
          if (
            !canvasManager.drawGpuRear({ position: center, contours, starTiles: [] }) ||
            !canvasManager.composeGpuRear(ctx)
          ) {
            throw new Error('Contour witness GPU frame failed');
          }
        }
        if (!gpu || canvasManager.requiresNativeGpuContours()) {
          const originalStroke = ctx.stroke;
          try {
            if (cap === 'butt') {
              ctx.stroke = new Proxy(originalStroke, {
                apply(targetFunction, receiver, argumentsList) {
                  ctx.lineCap = 'butt';
                  return Reflect.apply(targetFunction, receiver, argumentsList);
                },
              });
            }
            const submitted = drawContourLayers(center, contours);
            if (gpu) {
              canvasManager.recordNativeGpuContours(submitted);
            }
          } finally {
            ctx.stroke = originalStroke;
          }
        }
        const observation = imageCanvas(overlay.width, overlay.height);
        observation.context.drawImage(overlay, 0, 0);
        const pixel = (px: number) =>
          Array.from(readPixels(observation.context, Math.floor(px), Math.floor(y), 1, 1).data);
        return {
          body: [pixel(x - 12), pixel(x), pixel(x + 12)],
          caps: [pixel(x - capOffset), pixel(x + capOffset)],
          stats: gpu ? canvasManager.getGpuFrameStats() : null,
        };
      } finally {
        canvasManager.endWorldLayers(ctx);
      }
    };
    const normal = sample(layers);
    let nativeHairlineCaps: number[][] | null = null;
    let nativeHairlineButtCaps: number[][] | null = null;
    if (backend === 'canvas' || normal.stats?.contourMode === 'canvas-path') {
      const capA = world(x - 24.375, y);
      const capB = world(x + 24.375, y);
      const capLayers = [
        {
          index: 1,
          segments: [{ ax: capA.x, ay: capA.y, bx: capB.x, by: capB.y }],
        },
      ];
      // Keep this cap probe an observable hairline even at the smallest scan
      // zoom. The real scene's thin brightness is checked by `normal` above;
      // this independent .75px stroke tests native round-vs-butt cap support.
      const capWidth = VISUAL.CONTOUR_STROKE_WIDTH;
      try {
        setVisual('CONTOUR_STROKE_WIDTH', 0.75 / (zoom * dpr));
        const round = sample(capLayers, 'round', false, 25);
        const butt = sample(capLayers, 'butt', false, 25);
        if (
          backend === 'webgl2' &&
          (round.stats?.contourMode !== 'canvas-path' || round.stats.contourReason !== 'hairline')
        ) {
          throw new Error('Native cap witness must exercise the hairline painter');
        }
        nativeHairlineCaps = round.caps;
        nativeHairlineButtCaps = butt.caps;
      } finally {
        setVisual('CONTOUR_STROKE_WIDTH', capWidth);
      }
    }
    let omitted: number[][] | null = null;
    let doubled: number[][] | null = null;
    if (backend === 'webgl2') {
      omitted = sample([]).body;
      const alpha = VISUAL.CONTOUR_ALPHA;
      try {
        setVisual('CONTOUR_ALPHA', alpha * 2);
        doubled = sample(layers).body;
      } finally {
        setVisual('CONTOUR_ALPHA', alpha);
      }
    }
    // Eight backing pixels wide gives two fully covered round-cap pixels strictly
    // beyond each endpoint, at every zoom/DPR. A real native butt stroke omits them.
    const originalWidth = VISUAL.CONTOUR_STROKE_WIDTH;
    let caps: number[][];
    let buttCaps: number[][] | null = null;
    try {
      setVisual('CONTOUR_STROKE_WIDTH', 8 / (zoom * dpr));
      caps = sample(layers, 'round', false, 26).caps;
      if (backend === 'webgl2') {
        buttCaps = sample(layers, 'butt', true, 26).caps;
      }
    } finally {
      setVisual('CONTOUR_STROKE_WIDTH', originalWidth);
    }
    return {
      ...normal,
      caps,
      omitted,
      doubled,
      buttCaps,
      nativeHairlineCaps,
      nativeHairlineButtCaps,
    };
  }

  function compare(
    checkpoint: FrozenGpuCheckpoint,
    center: Position,
    reference: ReturnType<typeof imageCanvas>,
    gpuComposition: ReturnType<typeof imageCanvas>,
    layers: readonly GpuContourLayer[],
    zoom: number,
    rotation: number
  ) {
    const width = reference.canvas.width;
    const height = reference.canvas.height;
    const dpr = devicePixelRatio;
    const left = readPixels(reference.context, 0, 0, width, height);
    const right = readPixels(gpuComposition.context, 0, 0, width, height);
    const mask = contourMask(width, height, dpr, zoom, rotation, center, layers);
    const difference = imageCanvas(width, height);
    const maskImage = imageCanvas(width, height);
    const diffPixels = difference.context.createImageData(width, height);
    const maskPixels = maskImage.context.createImageData(width, height);
    let outsideDifferences = 0;
    let interiorDifferences = 0;
    let allowedEdgeDifferences = 0;
    let maxChannelDifference = 0;
    let referenceHash = 0;
    let gpuHash = 0;
    const firstFailures: {
      x: number;
      y: number;
      reference: number[];
      gpu: number[];
      interior: boolean;
    }[] = [];
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4;
      let differs = false;
      for (let channel = 0; channel < 4; channel++) {
        const a = left.data[offset + channel] ?? 0;
        const b = right.data[offset + channel] ?? 0;
        referenceHash = (Math.imul(referenceHash, 31) + a) >>> 0;
        gpuHash = (Math.imul(gpuHash, 31) + b) >>> 0;
        differs ||= a !== b;
        maxChannelDifference = Math.max(maxChannelDifference, Math.abs(a - b));
      }
      const interior = mask.interiors[pixel] === 1;
      const allowed = mask.edges[pixel] === 1 && !interior;
      maskPixels.data[offset + 1] = allowed ? 255 : 0;
      maskPixels.data[offset + 2] = interior ? 255 : 0;
      maskPixels.data[offset + 3] = 255;
      if (!differs) {
        continue;
      }
      if (interior) {
        interiorDifferences++;
      } else if (allowed) {
        allowedEdgeDifferences++;
      } else {
        outsideDifferences++;
      }
      diffPixels.data[offset] = allowed ? 0 : 255;
      diffPixels.data[offset + 1] = allowed ? 255 : 0;
      diffPixels.data[offset + 3] = 255;
      if (!allowed && firstFailures.length < 16) {
        firstFailures.push({
          x: pixel % width,
          y: Math.floor(pixel / width),
          interior,
          reference: Array.from(left.data.slice(offset, offset + 4)),
          gpu: Array.from(right.data.slice(offset, offset + 4)),
        });
      }
    }
    difference.context.putImageData(diffPixels, 0, 0);
    maskImage.context.putImageData(maskPixels, 0, 0);
    return {
      checkpoint,
      width,
      height,
      cssWidth: innerWidth,
      cssHeight: innerHeight,
      dpr,
      zoom,
      rotation,
      center,
      seed: 42,
      outsideDifferences,
      interiorDifferences,
      allowedEdgeDifferences,
      maxChannelDifference,
      referenceHash,
      gpuHash,
      firstFailures,
      pilots: [local.id, remote.id],
      asteroidCount: belt.roids.length,
      spiderCount: 1,
      frozenLaserCount: 2,
      segments: layers.reduce((sum, layer) => sum + layer.segments.length, 0),
      images: {
        canvas: reference.canvas.toDataURL(),
        webgl2: gpuComposition.canvas.toDataURL(),
        difference: difference.canvas.toDataURL(),
        allowedMask: maskImage.canvas.toDataURL(),
      },
    };
  }
  /** A single-frame probe isolates byte premultiplication from contour-edge coverage. */
  function probeQuantization() {
    const native = document.createElement('canvas');
    const width = Math.round(innerWidth * devicePixelRatio);
    const height = Math.round(innerHeight * devicePixelRatio);
    native.width = width;
    native.height = height;
    const context = native.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Quantization probe Canvas unavailable');
    }
    document.body.append(native);
    const gpu = GpuRearRenderer.create(native, () => {});
    if (!gpu) {
      native.remove();
      throw new Error('Quantization probe WebGL2 unavailable');
    }
    const alphas = [0.28, 0.37, 0.42, 0.51, 0.6, 0.69, 0.7, 0.83];
    const stars = alphas.map((alpha, index) => ({
      x: 12 + index * 12 - innerWidth / 2,
      y: 12 - innerHeight / 2,
      alpha,
    }));
    stars.push(
      ...alphas.flatMap((alpha, index) => [
        { x: 12 + index * 12 - innerWidth / 2, y: 22 - innerHeight / 2, alpha },
        { x: 12 + index * 12 - innerWidth / 2, y: 22 - innerHeight / 2, alpha: 0.69 },
      ])
    );
    stars.push({ x: 50 - innerWidth / 2, y: 35 - innerHeight / 2, alpha: 0.69 });
    const layers = [
      {
        index: 1,
        segments: [
          {
            ax: 10 - innerWidth / 2,
            ay: 25.5 - innerHeight / 2,
            bx: 100 - innerWidth / 2,
            by: 25.5 - innerHeight / 2,
          },
        ],
      },
      {
        index: 0,
        segments: [
          {
            ax: 10 - innerWidth / 2,
            ay: 35.5 - innerHeight / 2,
            bx: 100 - innerWidth / 2,
            by: 35.5 - innerHeight / 2,
          },
        ],
      },
    ];
    const originalWidth = VISUAL.CONTOUR_STROKE_WIDTH;
    try {
      setVisual('CONTOUR_STROKE_WIDTH', 3);
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      paintOpaqueBackground(context);
      for (const [index, alpha] of alphas.entries()) {
        context.fillStyle = hexToRgba(PALETTE.STARS, alpha);
        context.fillRect(12 + index * 12, 12, 1, 1);
        context.fillRect(12 + index * 12, 22, 1, 1);
        context.fillStyle = hexToRgba(PALETTE.STARS, 0.69);
        context.fillRect(12 + index * 12, 22, 1, 1);
      }
      context.fillStyle = hexToRgba(PALETTE.STARS, 0.69);
      context.fillRect(50, 35, 1, 1);
      if (
        !gpu.draw({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: 1,
          zoom: 1,
          rearSource: native,
          nativeStars: stars.length,
          nativeStarRects: stars.length,
          contours: layers,
        })
      ) {
        throw new Error('Quantization probe GPU draw failed');
      }
      for (const index of layers.keys()) {
        context.strokeStyle = hexToRgba(
          PALETTE.CONTOUR,
          index === 0 ? VISUAL.CONTOUR_ALPHA : VISUAL.CONTOUR_INDEX_ALPHA
        );
        context.lineWidth = 3;
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(10, index === 0 ? 25.5 : 35.5);
        context.lineTo(100, index === 0 ? 25.5 : 35.5);
        context.stroke();
      }
      const source = native.previousElementSibling;
      if (!(source instanceof HTMLCanvasElement) || source.id !== 'gameGpuCanvas') {
        throw new Error('Quantization GPU bitmap missing');
      }
      const left = imageCanvas(width, height);
      const right = imageCanvas(width, height);
      left.context.drawImage(native, 0, 0);
      right.context.drawImage(source, 0, 0);
      const sample = (x: number, y: number) => ({
        canvas: Array.from(
          readPixels(
            left.context,
            Math.floor(x * devicePixelRatio),
            Math.floor(y * devicePixelRatio),
            1,
            1
          ).data
        ),
        webgl2: Array.from(
          readPixels(
            right.context,
            Math.floor(x * devicePixelRatio),
            Math.floor(y * devicePixelRatio),
            1,
            1
          ).data
        ),
      });
      const bucketResults = {
        dpr: devicePixelRatio,
        stars: alphas.map((alpha, index) => ({ alpha, ...sample(12 + index * 12, 12) })),
        overlappingStars: alphas.map((alpha, index) => ({ alpha, ...sample(12 + index * 12, 22) })),
        contours: [
          { alpha: VISUAL.CONTOUR_ALPHA, ...sample(50, 25.5) },
          { alpha: VISUAL.CONTOUR_INDEX_ALPHA, ...sample(50, 35.5) },
        ],
      };
      const lowCoverage: {
        alpha: number;
        step: number;
        destinationPasses: number;
        destination: number[];
        canvas: number[];
        webgl2: number[];
        coverageCanvas: number;
        coverageWebgl2: number;
      }[] = [];
      let lowCoveragePixelDifferences = 0;
      for (const step of [0.37, 0.42391303181648254]) {
        const zoom = step / devicePixelRatio;
        const virtualWidth = innerWidth / zoom;
        const virtualHeight = innerHeight / zoom;
        const fore: StarPoint[] = [];
        const behind: StarPoint[] = [];
        const points: { x: number; y: number; passes: number }[] = [];
        for (const [row, passes] of [0, 3, 12, 48].entries()) {
          for (const snappedX of step === 0.37 ? [27, 45, 54, 72] : [25, 33, 58, 66]) {
            const snappedY = 60 + row * 20;
            const start = snappedX * step;
            const end = (snappedX + 1) * step;
            const pixelX = start % 1 > 0.975 ? Math.floor(start) : Math.floor(end);
            const pixelY = Math.floor(snappedY * step);
            const foreground = {
              x: snappedX - virtualWidth / 2,
              y: snappedY - virtualHeight / 2,
              alpha: 0.53,
            };
            fore.push(foreground);
            points.push({ x: pixelX, y: pixelY, passes });
            for (let pass = 0; pass < passes; pass++) {
              behind.push({
                x: Math.round((pixelX + 0.15) / step) - virtualWidth / 2,
                y: Math.round((pixelY + 0.15) / step) - virtualHeight / 2,
                alpha: 0.83,
              });
            }
          }
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        paintOpaqueBackground(context);
        context.setTransform(step, 0, 0, step, 0, 0);
        const paintStars = (items: readonly StarPoint[]) => {
          for (const star of items) {
            context.fillStyle = hexToRgba(PALETTE.STARS, star.alpha);
            context.fillRect(
              (star.x + virtualWidth / 2 + 0.5) | 0,
              (star.y + virtualHeight / 2 + 0.5) | 0,
              VISUAL.STAR_SIZE,
              VISUAL.STAR_SIZE
            );
          }
        };
        paintStars(behind);
        left.context.drawImage(native, 0, 0);
        const destinations = points.map(({ x, y }) =>
          Array.from(readPixels(left.context, x, y, 1, 1).data)
        );
        paintStars(fore);
        if (
          !gpu.draw({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
            position: { x: 0, y: 0 },
            rotation: 0,
            scale: 1,
            zoom,
            rearSource: native,
            nativeStars: behind.length + fore.length,
            nativeStarRects: behind.length + fore.length,
            contours: [],
          })
        ) {
          throw new Error('Low-coverage quantization probe failed');
        }
        left.context.drawImage(native, 0, 0);
        right.context.drawImage(source, 0, 0);
        lowCoveragePixelDifferences += countDifferentChannels(left, right);
        const colorSamples = points.map((point) => ({
          canvas: Array.from(readPixels(left.context, point.x, point.y, 1, 1).data),
          webgl2: Array.from(readPixels(right.context, point.x, point.y, 1, 1).data),
        }));
        // Opaque white over black exposes the native coverage byte directly,
        // independently of star color, opacity, or destination SrcOver rounding.
        context.setTransform(1, 0, 0, 1, 0, 0);
        paintOpaqueBackground(context);
        context.setTransform(step, 0, 0, step, 0, 0);
        context.fillStyle = '#ffffff';
        for (const star of fore) {
          context.fillRect(
            (star.x + virtualWidth / 2 + 0.5) | 0,
            (star.y + virtualHeight / 2 + 0.5) | 0,
            VISUAL.STAR_SIZE,
            VISUAL.STAR_SIZE
          );
        }
        left.context.drawImage(native, 0, 0);
        if (
          !gpu.draw({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
            position: { x: 0, y: 0 },
            rotation: 0,
            scale: 1,
            zoom,
            rearSource: native,
            nativeStars: fore.length,
            nativeStarRects: fore.length,
            contours: [],
          })
        ) {
          throw new Error('Independent coverage probe GPU draw failed');
        }
        right.context.drawImage(source, 0, 0);
        for (const [index, point] of points.entries()) {
          lowCoverage.push({
            alpha: 0.53,
            step,
            destinationPasses: point.passes,
            destination: destinations[index] ?? [],
            canvas: colorSamples[index]?.canvas ?? [],
            webgl2: colorSamples[index]?.webgl2 ?? [],
            coverageCanvas: readPixels(left.context, point.x, point.y, 1, 1).data[0] ?? 0,
            coverageWebgl2: readPixels(right.context, point.x, point.y, 1, 1).data[0] ?? 0,
          });
        }
      }
      return {
        ...bucketResults,
        lowCoverage,
        lowCoveragePixelDifferences,
        zeroSourceWitnesses: lowCoverage.filter(
          (pixel) => pixel.destination[2] === 17 && pixel.canvas[2] === 16 && pixel.canvas[0] === 0
        ).length,
        distinctDestinations: new Set(lowCoverage.map((pixel) => pixel.destination.join(','))).size,
      };
    } finally {
      setVisual('CONTOUR_STROKE_WIDTH', originalWidth);
      gpu.destroy();
      native.remove();
    }
  }
  function probeBackground() {
    const overlay = canvasManager.requireCanvas();
    const ctx = canvasManager.requireContext();
    const before = imageCanvas(overlay.width, overlay.height);
    const legacy = document.createElement('canvas');
    legacy.width = overlay.width;
    legacy.height = overlay.height;
    const legacyContext = legacy.getContext('2d', { alpha: false });
    if (!legacyContext) {
      throw new Error('Legacy background observation unavailable');
    }
    legacyContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    legacyContext.fillStyle = PALETTE.BG;
    legacyContext.fillRect(0, 0, innerWidth, innerHeight);
    before.context.drawImage(legacy, 0, 0);
    paintOpaqueBackground(legacyContext);
    const after = imageCanvas(overlay.width, overlay.height);
    after.context.drawImage(legacy, 0, 0);
    const oldPixels = readPixels(before.context, 0, 0, overlay.width, overlay.height).data;
    const newPixels = readPixels(after.context, 0, 0, overlay.width, overlay.height).data;
    let changedPadding = 0;
    let changedInnerPixels = 0;
    for (let pixel = 0; pixel < overlay.width * overlay.height; pixel++) {
      const offset = pixel * 4;
      if (
        oldPixels
          .subarray(offset, offset + 4)
          .every((value, index) => value === newPixels[offset + index])
      ) {
        continue;
      }
      const x = pixel % overlay.width;
      const y = Math.floor(pixel / overlay.width);
      if (
        x >= Math.floor(innerWidth * devicePixelRatio) ||
        y >= Math.floor(innerHeight * devicePixelRatio)
      ) {
        changedPadding++;
      } else {
        changedInnerPixels++;
      }
    }
    const expected = [0, 0, 17, 255];
    const frames: { stalePixels: number; restoredTransform: boolean; restoredStyle: boolean }[] =
      [];
    ctx.save();
    try {
      ctx.globalAlpha = 0.31;
      ctx.fillStyle = '#456789';
      const transform = ctx.getTransform().toString();
      const style = ctx.fillStyle;
      for (const color of ['#ff0000', '#00ffff']) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, overlay.width, overlay.height);
        ctx.restore();
        // Exercise the actual public surface painter repeatedly over contradictory
        // old pixels; a partial CSS-sized paint leaves observable red/cyan padding.
        canvasManager.clearPlayfield();
        const image = imageCanvas(overlay.width, overlay.height);
        image.context.drawImage(overlay, 0, 0);
        const pixels = readPixels(image.context, 0, 0, overlay.width, overlay.height).data;
        let stalePixels = 0;
        for (let pixel = 0; pixel < overlay.width * overlay.height; pixel++) {
          if (expected.some((value, index) => pixels[pixel * 4 + index] !== value)) {
            stalePixels++;
          }
        }
        frames.push({
          stalePixels,
          restoredTransform: ctx.getTransform().toString() === transform,
          restoredStyle: ctx.fillStyle === style && ctx.globalAlpha === 0.31,
        });
      }
    } finally {
      ctx.restore();
    }
    return { changedPadding, changedInnerPixels, frames };
  }
  return {
    capture,
    finish,
    probeQuantization,
    probeBackground,
    getCompletedReadbacks: pixelCaptures.count,
  };
}
