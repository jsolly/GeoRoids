import pageMarkup from '../index.html?raw';
import '../index.css';
import { CLIENT_ID_STORAGE_KEY } from '../src/network/services/clientIdentity';
import {
  type ClientScene,
  type ClientSceneFrame,
  clientSceneSpiders,
  clientSceneTraits,
  validateClientSceneFrames,
  verifyClientSceneAbility,
  verifyClientScenePresentation,
} from './client-scenes';
import {
  GPU_WORK_COUNTERS,
  gpuFrameSequence,
  observeGpuRenderedFrame,
} from './gpu-frame-observation';

export interface ClientOptions {
  seed: number;
  warmupFrames: number;
  measuredFrames: number;
  viewport: 'desktop' | 'touch-portrait' | 'touch-landscape' | 'tablet';
  renderer?: 'canvas' | 'webgl2';
  dpr?: number;
  chromiumGpu?: boolean;
  scene?: ClientScene;
}

const FRAME_MS = 1000 / 60;
const EPOCH_MS = 1_700_000_000_000;

// Preserve the product's DOM and CSS without its event loop, release poller, or CDN scripts.
const markup = new DOMParser().parseFromString(pageMarkup, 'text/html');
for (const script of markup.querySelectorAll('script')) {
  script.remove();
}
document.body.innerHTML = markup.body.innerHTML;

async function runClientFixture(options: ClientOptions & { observe: boolean }) {
  const scene = options.scene ?? 'stationary';
  const traits = clientSceneTraits(scene);
  validateClientSceneFrames(scene, options.warmupFrames, options.measuredFrames);
  const originalRandom = Math.random;
  const originalNow = Date.now;
  const NativeAudio = window.Audio;
  let randomState = options.seed >>> 0;
  let frame = 0;
  // Presentation must match between fresh contexts; CPU timing keeps its native clock.
  const nativeNow = performance.now.bind(performance);
  const performanceNowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  Math.random = () => {
    randomState = (randomState + 0x6d2b79f5) | 0;
    let value = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  Date.now = () => EPOCH_MS + frame * FRAME_MS;
  // Sound eagerly constructs media elements. Keep native elements, with no source/preload,
  // before importing any game module. Audio is deliberately outside this rendering fixture.
  window.Audio = class extends NativeAudio {
    constructor() {
      super();
      this.preload = 'none';
      this.muted = true;
    }
  };
  localStorage.setItem('soundOn', 'false');
  const restores: (() => void)[] = [];
  if (traits.presentationClock === 'fixed-60hz') {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => frame * FRAME_MS,
    });
    restores.push(() => {
      if (performanceNowDescriptor) {
        Object.defineProperty(performance, 'now', performanceNowDescriptor);
      } else {
        Reflect.deleteProperty(performance, 'now');
      }
    });
  }
  const operationFailures: unknown[] = [];
  const result = await (async () => {
    try {
      sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, 'benchmark-local');
      // Importing the forwarder does not start it. The ordinary event-loop bootstrap does;
      // this fixture never imports that bootstrap. Any later socket attempt fails the runner.
      const { stopClientLogForwarder } = await import('../src/utils/logForwarder');
      stopClientLogForwarder();
      const { GameController } = await import('../src/core/gameController');
      const { GameStateManager } = await import('../src/core/services/GameStateManager');
      const { NetworkManager } = await import('../src/network/networkManager');
      const { canvasManager } = await import('../src/rendering/canvasSurface');
      const { Roid } = await import('../src/entities/roid/Roid');
      const { LootField } = await import('../src/entities/loot/LootField');
      const { SatellitePickupManager } = await import(
        '../src/entities/satellitePickup/SatellitePickupManager'
      );
      const { satelliteProfileAt } = await import('../shared/eoSatellites');
      const { SATELLITE_PICKUP } = await import('../src/constants');
      const { ensureTerrain, getTerrainContours } = await import(
        '../src/physics/terrain/terrainSession'
      );
      const { setPlayView } = await import('../src/ui/uiUtils');
      const { syncTouchChrome } = await import('../src/input/touchControls');
      const game = GameController.getInstance();
      const state = GameStateManager.getInstance();
      const network = NetworkManager.getInstance();
      if (state.getIsGameRunning() || network.isConnected) {
        throw new Error('Fixture booted live gameplay');
      }
      canvasManager.initialize();
      restores.push(() => canvasManager.destroy(), stopClientLogForwarder);
      game.newGame('Benchmark Pilot', traits.kit);
      const createdLocal = game.getCurrPlayer();
      if (!createdLocal) {
        throw new Error('Local pilot is missing');
      }
      const local = createdLocal;
      local.id = network.getLocalPlayerId();
      if (local.id !== 'benchmark-local') {
        throw new Error('Fixture local renderer identity differs from its declared pilot');
      }
      local.ship.id = 'benchmark-local-ship';
      local.ship.position = { x: 0, y: 0 };
      local.ship.velocity = { x: 0, y: 0 };
      // Public authoritative-pose mode keeps the camera stationary while normal lifecycle,
      // cooldown, asteroid motion, collision checks, and rendering continue to execute.
      local.ship.serverOwnsMotion = true;
      local.ship.blinkCount = 0;
      local.ship.blinkOn = false;
      local.ship.spawnProtectionTimer = 0;
      let activateCalls = 0;
      function activateScan() {
        activateCalls++;
        if (
          !local.ship.activateAbility() ||
          local.ship.abilityActiveFrames !== 120 ||
          local.ship.abilityCooldownFrames !== 1200
        ) {
          throw new Error('Fixture requires one ordinary Scout Mineral Scan activation');
        }
      }
      if (traits.activation === 'before-warmup') {
        activateScan();
      }
      const totalFrames = options.warmupFrames + options.measuredFrames;
      const belt = game.getCurrRoidBelt();
      for (let index = 0; index < 24; index++) {
        const angle = (index / 24) * Math.PI * 2;
        const radius = 105 + (index % 3) * 14;
        const roid = new Roid(
          { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
          5 + (index % 3) * 2,
          `benchmark-asteroid-${index}`
        );
        roid.velocity = { x: 0.005, y: -0.003 };
        belt.roids.push(roid);
      }
      const loot = LootField.getInstance();
      loot.applySnapshot(
        Array.from({ length: 6 }, (_, index) => ({
          id: `benchmark-loot-${index}`,
          position: { x: -75 + index * 30, y: 75 },
          mass: 1,
          radius: 4,
          kind: 'shard',
        }))
      );
      const pickups = SatellitePickupManager.getInstance();
      pickups.syncFromServer(
        Array.from({ length: 6 }, (_, index) => {
          const profile = satelliteProfileAt(index);
          return {
            id: `benchmark-pickup-${index}`,
            name: profile.displayName,
            typeId: profile.typeId,
            assetKey: profile.assetKey,
            position: {
              x: -75 + (index % 3) * 75,
              y: index < 3 ? -70 : 110,
            },
            velocity: { x: 0, y: 0 },
            angle: index,
            radius: SATELLITE_PICKUP.SIZE / 2,
            color: profile.hullColor,
            state: 'loose' as const,
            ownerId: null,
            health: SATELLITE_PICKUP.HEALTH,
            maxHealth: SATELLITE_PICKUP.HEALTH,
          };
        })
      );
      const spiders = traits.spiders ? clientSceneSpiders() : [];
      if (scene !== 'stationary') {
        const { setSpiderField } = await import('../src/physics/terrain/spiderSession');
        setSpiderField({ nests: [], spiders });
        restores.push(() => setSpiderField(undefined));
      }
      state.clearOverlay();
      ensureTerrain(options.seed);
      setPlayView(true);
      syncTouchChrome(true);
      const probe = document.querySelector('#safe-area-probe');
      if (!(probe instanceof HTMLElement)) {
        throw new Error('Safe-area probe is missing');
      }
      probe.style.padding = options.viewport === 'touch-portrait' ? '47px 0px 34px 0px' : '0px';
      window.dispatchEvent(new Event('resize'));
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const canvas = canvasManager.requireCanvas();
      const ctx = canvasManager.requireContext();
      const opaqueFrame = ctx.getContextAttributes().alpha === false;
      const viewport = { ...canvasManager.getViewportSize() };
      if (
        !canvas.checkVisibility() ||
        document.visibilityState !== 'visible' ||
        canvas.width !== Math.round(innerWidth * (options.dpr ?? 1)) ||
        canvas.height !== Math.round(innerHeight * (options.dpr ?? 1)) ||
        navigator.maxTouchPoints > 0 !== (options.viewport !== 'desktop')
      ) {
        throw new Error('Canvas visibility, dimensions, or touch capability do not match fixture');
      }

      // The fixed harness also runs against revisions predating the GPU API.
      const surface: object = canvasManager;
      function rendererBackend(): 'canvas' | 'webgl2' {
        if ('getRendererBackend' in surface && typeof surface.getRendererBackend === 'function') {
          const backend: unknown = surface.getRendererBackend();
          if (backend === 'canvas' || backend === 'webgl2') {
            return backend;
          }
          throw new Error('Unknown observed renderer backend');
        }
        return 'canvas';
      }
      function gpuFrameStats(): unknown {
        return 'getGpuFrameStats' in surface && typeof surface.getGpuFrameStats === 'function'
          ? surface.getGpuFrameStats()
          : null;
      }

      function snapshot() {
        return {
          local: {
            id: local.id,
            shipId: local.ship.id,
            position: { ...local.ship.position },
            health: local.ship.health,
            cargo: local.cargo,
            purchases: local.purchases,
            exploding: local.ship.exploding,
          },
          asteroids: belt.roids.map((roid) => ({
            id: roid.id,
            position: { ...roid.position },
            health: roid.health,
            vertices: roid.vertices,
            offsets: [...roid.offsets],
          })),
          loot: loot.getAll().map((item) => ({ id: item.id, position: { ...item.position } })),
          pickups: pickups
            .getAll()
            .map((item) => ({ id: item.id, state: item.state, position: { ...item.position } })),
          ...(scene === 'stationary'
            ? {}
            : {
                scene: {
                  kit: local.ship.kitId,
                  activeFrames: local.ship.abilityActiveFrames,
                  cooldownFrames: local.ship.abilityCooldownFrames,
                  spiders: spiders.map((spider) => ({
                    ...spider,
                    position: { ...spider.position },
                  })),
                },
              }),
        };
      }
      const before = snapshot();
      let canvasCalls: Record<string, number> = {};
      const textCalls: string[] = [];
      let record = false;
      let phase: 'update' | 'render' = 'update';
      const frameWork: Array<Record<string, number>> = [];
      const sceneFrames: ClientSceneFrame[] = [];
      let sceneFrame: ClientSceneFrame = {
        frame: 0,
        zoom: 1,
        nativeScale: 1,
        virtualWidth: viewport.width,
        virtualHeight: viewport.height,
        activeFrames: 0,
        cooldownFrames: 0,
        worldLayerBegins: 0,
        spiderLegStrokes: 0,
        spiderBodyEllipses: 0,
        infestationStrokes: 0,
        canvasCreates: 0,
      };
      function countWork(name: string, amount = 1) {
        if (record) {
          const key = `${phase}.${name}`;
          canvasCalls[key] = (canvasCalls[key] ?? 0) + amount;
        }
      }
      // Observation-only property probes count actual reads, not estimated work.
      // Preserve writes so the fixture still exercises normal simulation.
      function observeRead(target: object, key: string, name: string) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.configurable) {
          throw new Error(`Cannot observe ${name}`);
        }
        let value: unknown = descriptor.value;
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          get() {
            countWork(name);
            return value;
          },
          set(next: unknown) {
            value = next;
          },
        });
        // A successfully installed probe can observe zero reads on a cached frame.
        // Keep that distinct from a missing probe in the strict work-budget check.
        for (const prefix of ['update', 'render']) {
          canvasCalls[`${prefix}.${name}`] ??= 0;
        }
        restores.push(() => Object.defineProperty(target, key, { ...descriptor, value }));
      }
      if (options.observe) {
        for (const [kind, actors] of [
          ['localShip', [local.ship]],
          ['asteroid', belt.roids],
          ['loot', loot.getAll()],
          ['pickup', pickups.getAll()],
          ['spider', spiders],
        ] satisfies [string, readonly object[]][]) {
          for (const actor of actors) {
            observeRead(actor, 'position', `${kind}.positionReads`);
          }
        }
        // Dynamic terrain replaces contour sets during scan. Omit this metric rather
        // than report partial endpoint coverage as an apparent work reduction.
        for (const level of scene === 'stationary' ? getTerrainContours() : []) {
          for (const segment of level.segments) {
            for (const key of ['ax', 'ay', 'bx', 'by']) {
              observeRead(segment, key, 'contour.endpointReads');
            }
          }
        }
        if (scene !== 'stationary') {
          const beginWorld = canvasManager.beginWorldLayers;
          const nativeTransform = ctx.getTransform;
          canvasManager.beginWorldLayers = (context) => {
            beginWorld.call(canvasManager, context);
            if (record) {
              sceneFrame.worldLayerBegins++;
              const world = canvasManager.getViewportSize();
              const transform = nativeTransform.call(context);
              sceneFrame.zoom = viewport.width / world.width;
              sceneFrame.nativeScale = Math.hypot(transform.a, transform.b) / (options.dpr ?? 1);
              sceneFrame.virtualWidth = world.width;
              sceneFrame.virtualHeight = world.height;
            }
          };
          restores.push(() => {
            canvasManager.beginWorldLayers = beginWorld;
          });
          const createElement = document.createElement;
          document.createElement = new Proxy(createElement, {
            apply(target, receiver, args) {
              const element = Reflect.apply(target, receiver, args);
              if (record && args[0] === 'canvas') {
                sceneFrame.canvasCreates++;
                countWork('canvasCreates');
              }
              return element;
            },
          });
          canvasCalls['update.canvasCreates'] = 0;
          canvasCalls['render.canvasCreates'] = 0;
          restores.push(() => {
            document.createElement = createElement;
          });
        }
        const instrumentPrototypeMethod = (
          prefix: string,
          key: string,
          original: (...args: unknown[]) => unknown
        ) =>
          function (this: object, ...args: unknown[]) {
            if (record) {
              if (scene !== 'stationary' && this === ctx) {
                if (
                  key === 'stroke' &&
                  (ctx.strokeStyle === '#170d19' || ctx.strokeStyle === '#bd596a')
                ) {
                  sceneFrame.spiderLegStrokes++;
                }
                if (key === 'ellipse' && ctx.fillStyle === '#200e20') {
                  sceneFrame.spiderBodyEllipses++;
                }
                if (
                  key === 'stroke' &&
                  typeof ctx.strokeStyle === 'string' &&
                  ctx.strokeStyle.startsWith('rgba(236, 58, 83,')
                ) {
                  sceneFrame.infestationStrokes++;
                }
              }
              const name = `${prefix}.${key}`;
              countWork(name);
              canvasCalls[name] = (canvasCalls[name] ?? 0) + 1;
              if (key === 'fillText' && typeof args[0] === 'string') {
                textCalls.push(args[0]);
              }
            }
            return Reflect.apply(original, this, args);
          };
        for (const [prefix, prototype] of [
          ['canvas', CanvasRenderingContext2D.prototype],
          ['path', Path2D.prototype],
          ['webgl2', WebGL2RenderingContext.prototype],
        ] satisfies [string, object][]) {
          for (const key of Object.getOwnPropertyNames(prototype)) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
            const original: unknown = descriptor?.value;
            if (key === 'constructor' || typeof original !== 'function' || !descriptor) {
              continue;
            }
            Object.defineProperty(prototype, key, {
              ...descriptor,
              value: instrumentPrototypeMethod(
                prefix,
                key,
                original as (...args: unknown[]) => unknown
              ),
            });
            restores.push(() => Object.defineProperty(prototype, key, descriptor));
          }
        }
      }
      const samples: { frameIntervalMs: number[]; updateMs: number[]; renderMs: number[] } = {
        frameIntervalMs: [],
        updateMs: [],
        renderMs: [],
      };
      let previousRaf: number | undefined;
      let composedPixels: Uint8ClampedArray | undefined;
      let observedBackend: 'canvas' | 'webgl2' = 'canvas';
      let observedGpuStats: unknown = null;
      const rendererFrames = { canvas: 0, webgl2: 0 };
      let measuredGpuFrames = 0;
      const checkpointImages: { frame: number; sha256: string }[] = [];
      let observationCaptures = 0;
      function captureFrame(backend: 'canvas' | 'webgl2') {
        const composed = document.createElement('canvas');
        composed.width = canvas.width;
        composed.height = canvas.height;
        const read = composed.getContext('2d', { willReadFrequently: true });
        if (!read) {
          throw new Error('Composed frame reader unavailable');
        }
        if (backend === 'webgl2' && !opaqueFrame) {
          const rear = document.querySelector('#gameGpuCanvas');
          if (!(rear instanceof HTMLCanvasElement)) {
            throw new Error('Observed GPU backend has no rear canvas');
          }
          read.drawImage(rear, 0, 0);
        }
        read.drawImage(canvas, 0, 0);
        const pixels = read.getImageData(0, 0, canvas.width, canvas.height).data;
        observationCaptures++;
        return pixels;
      }
      async function pixelDigest(pixels: Uint8ClampedArray) {
        return Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(pixels))),
          (byte) => byte.toString(16).padStart(2, '0')
        ).join('');
      }
      await new Promise<void>((resolve, reject) => {
        const step = (timestamp: number) => {
          try {
            const measured = frame >= options.warmupFrames;
            if (frame === options.warmupFrames && traits.activation === 'after-warmup') {
              record = false;
              activateScan();
            }
            record = options.observe && measured;
            const beforeWork = record ? { ...canvasCalls } : undefined;
            frame++;
            if (record && scene !== 'stationary') {
              sceneFrame = {
                frame: frame - options.warmupFrames,
                zoom: 1,
                nativeScale: 1,
                virtualWidth: viewport.width,
                virtualHeight: viewport.height,
                activeFrames: 0,
                cooldownFrames: 0,
                worldLayerBegins: 0,
                spiderLegStrokes: 0,
                spiderBodyEllipses: 0,
                infestationStrokes: 0,
                canvasCreates: 0,
              };
            }
            phase = 'update';
            countWork('calls');
            const start = traits.presentationClock === 'native' ? performance.now() : nativeNow();
            game.updateGame(FRAME_MS);
            const updated = traits.presentationClock === 'native' ? performance.now() : nativeNow();
            // Snapshot the sequence between update and render, outside both CPU intervals.
            // A large warmup count cannot stand in for this particular measured render.
            const gpuBefore =
              measured && options.renderer === 'webgl2' ? gpuFrameSequence(gpuFrameStats()) : null;
            phase = 'render';
            countWork('calls');
            const renderStarted =
              traits.presentationClock === 'native' ? performance.now() : nativeNow();
            game.renderGame();
            const rendered =
              traits.presentationClock === 'native' ? performance.now() : nativeNow();
            if (measured) {
              const backend = rendererBackend();
              rendererFrames[backend]++;
              if (backend !== (options.renderer ?? 'canvas')) {
                throw new Error(`Measured frame used ${backend} instead of the requested renderer`);
              }
              if (gpuBefore !== null) {
                observedGpuStats = gpuFrameStats();
                const observed = observeGpuRenderedFrame(gpuBefore, observedGpuStats);
                measuredGpuFrames++;
                if (record) {
                  countWork(`gpu.${observed.contourMode}.frames`);
                  countWork(`gpu.${observed.contourMode}.${observed.contourReason}.frames`);
                  for (const name of GPU_WORK_COUNTERS) {
                    countWork(`gpu.${name}`, observed.work[name]);
                  }
                }
              }
            }
            if (measured && !options.observe) {
              if (previousRaf === undefined) {
                throw new Error('Missing preceding rAF callback');
              }
              samples.frameIntervalMs.push(timestamp - previousRaf);
              samples.updateMs.push(updated - start);
              samples.renderMs.push(rendered - renderStarted);
            }
            if (beforeWork) {
              frameWork.push(
                Object.fromEntries(
                  Object.entries(canvasCalls)
                    .filter(([name]) => name.startsWith('update.') || name.startsWith('render.'))
                    .map(([name, count]) => [name, count - (beforeWork[name] ?? 0)])
                )
              );
            }
            if (record && scene !== 'stationary') {
              sceneFrame.activeFrames = local.ship.abilityActiveFrames;
              sceneFrame.cooldownFrames = local.ship.abilityCooldownFrames;
              sceneFrames.push({ ...sceneFrame });
              if (
                canvasManager.getViewportSize().width !== viewport.width ||
                canvasManager.getViewportSize().height !== viewport.height
              ) {
                throw new Error('Scene did not restore its HUD viewport');
              }
            }
            let checkpointDigest: Promise<void> | undefined;
            if (options.observe && traits.checkpoints.includes(frame - options.warmupFrames)) {
              // Read the current default GPU buffer before returning from this RAF.
              // Hash/readback runs outside work counters and all CPU timing boundaries.
              record = false;
              const pixels = captureFrame(rendererBackend());
              if (frame === totalFrames) {
                composedPixels = pixels;
              }
              const capturedFrame = frame - options.warmupFrames;
              checkpointDigest = pixelDigest(pixels).then((sha256) => {
                checkpointImages.push({ frame: capturedFrame, sha256 });
              });
            }
            previousRaf = timestamp;
            if (frame < totalFrames) {
              // Observation checkpoints finish before the next callback so large
              // backing images cannot accumulate. Timing contexts never take this path.
              if (checkpointDigest !== undefined) {
                void checkpointDigest.then(() => requestAnimationFrame(step), reject);
              } else {
                requestAnimationFrame(step);
              }
            } else {
              record = false;
              observedBackend = rendererBackend();
              if (observedBackend !== (options.renderer ?? 'canvas')) {
                throw new Error(`Requested renderer fell back to ${observedBackend}`);
              }
              if (observedBackend === 'webgl2' && measuredGpuFrames !== options.measuredFrames) {
                throw new Error('Incomplete per-render GPU observations');
              }
              if (options.observe) {
                // Capture the actual final opaque frame here, outside timed work.
                // Older transparent revisions need their rear bitmap as well,
                // before WebGL's default buffer clears after this callback.
                composedPixels ??= captureFrame(observedBackend);
              }
              if (checkpointDigest !== undefined) {
                void checkpointDigest.then(resolve, reject);
              } else {
                resolve();
              }
            }
          } catch (error) {
            reject(error);
          }
        };
        requestAnimationFrame(step);
      });
      record = false;
      if (options.observe && !composedPixels) {
        throw new Error('Composed final frame was not captured');
      }
      const frameImageSha256 = options.observe
        ? await pixelDigest(composedPixels ?? new Uint8ClampedArray())
        : null;
      if (scene !== 'stationary') {
        verifyClientSceneAbility(
          scene,
          local.ship.abilityActiveFrames,
          local.ship.abilityCooldownFrames
        );
        if (activateCalls !== (traits.activation === 'none' ? 0 : 1)) {
          throw new Error('Fixture repeated or omitted its ability activation');
        }
        if (options.observe) {
          verifyClientScenePresentation(scene, viewport, sceneFrames);
          if (
            checkpointImages.length !== traits.checkpoints.length ||
            checkpointImages.some((row, index) => row.frame !== traits.checkpoints[index]) ||
            checkpointImages.at(-1)?.sha256 !== frameImageSha256
          ) {
            throw new Error('Incomplete checkpoint pixel witnesses');
          }
        }
      }
      const after = snapshot();
      if (
        after.local.health !== before.local.health ||
        after.local.health !== before.local.health ||
        after.local.exploding ||
        after.local.position.x !== 0 ||
        after.local.position.y !== 0 ||
        after.asteroids.length !== 24 ||
        after.loot.length !== 6 ||
        after.pickups.length !== 6
      ) {
        throw new Error('Visible fixture did not survive with its expected lifecycle outcome');
      }
      if (
        JSON.stringify(before.loot) !== JSON.stringify(after.loot) ||
        JSON.stringify(before.pickups) !== JSON.stringify(after.pickups)
      ) {
        throw new Error('Fixture lost or changed a stationary scene participant');
      }
      const visibleActors = [...after.asteroids, ...after.loot, ...after.pickups].filter(
        (actor) => {
          const screen = canvasManager.worldToScreen(actor.position, local.ship.position);
          return (
            screen.x >= 24 &&
            screen.y >= 24 &&
            screen.x <= viewport.width - 24 &&
            screen.y <= viewport.height - 24
          );
        }
      ).length;
      if (visibleActors !== 36) {
        throw new Error('Fixture participants fell outside the visible playfield');
      }
      for (const [index, roid] of after.asteroids.entries()) {
        const initial = before.asteroids[index];
        if (
          !initial ||
          roid.id !== initial.id ||
          roid.health !== initial.health ||
          Math.abs(roid.position.x - initial.position.x - totalFrames * 0.005) > 1e-8 ||
          Math.abs(roid.position.y - initial.position.y + totalFrames * 0.003) > 1e-8
        ) {
          throw new Error(`Asteroid ${roid.id} did not execute its expected visible motion`);
        }
      }
      const measuredCalls = canvasCalls;
      const untimed: Record<string, unknown> = {};
      if (scene !== 'stationary') {
        const visibleSpiders = spiders.filter((spider) => {
          const screen = canvasManager.worldToScreen(spider.position, local.ship.position);
          return (
            screen.x >= 24 &&
            screen.y >= 24 &&
            screen.x <= viewport.width - 24 &&
            screen.y <= viewport.height - 24
          );
        }).length;
        if (
          visibleSpiders !== traits.spiders ||
          JSON.stringify(before.scene?.spiders) !== JSON.stringify(after.scene?.spiders)
        ) {
          throw new Error('Scene lost or moved a declared spider snapshot participant');
        }
        if (options.observe) {
          untimed['scene'] = {
            probesInstalled: {
              worldProjection: true,
              canvasCreation: true,
              spiderPainting: traits.spiders > 0,
            },
            contourEndpointProbeCoverage: 'not-instrumented: dynamic terrain sets',
            activateCalls,
            visibleSpiders,
            frames: sceneFrames,
            checkpointImages,
          };
        }
      }
      const untimedCounts: Record<string, number> = {};
      if (options.observe) {
        const { hudLayoutForCanvas, computeHudLayout } = await import(
          '../src/rendering/hud/hudLayout'
        );
        const { drawScoreOverlay, drawTextOverlay } = await import('../src/rendering/hud/gameInfo');
        const { drawMiniMap } = await import('../src/rendering/hud/minimap');
        const { drawLeaderboard } = await import('../src/rendering/hud/leaderboard');
        const { entityFactory } = await import('../src/entities/EntityFactory');
        const { drawFieryBoundary } = await import('../src/rendering/boundaryRenderer');
        const { getGameBoundary } = await import('../src/physics/boundary');
        const reads = { safeAreaStyles: 0, pointerMediaQueries: 0 };
        const originalStyle = window.getComputedStyle;
        const originalMedia = window.matchMedia;
        window.getComputedStyle = (element, pseudo) => {
          if (element === probe) {
            reads.safeAreaStyles++;
          }
          return originalStyle.call(window, element, pseudo);
        };
        window.matchMedia = (query) => {
          if (query === '(pointer: coarse)' || query === '(hover: none)') {
            reads.pointerMediaQueries++;
          }
          return originalMedia.call(window, query);
        };
        restores.push(() => {
          window.getComputedStyle = originalStyle;
          window.matchMedia = originalMedia;
        });
        // Canvas recording remains off for this separate full-render environment probe.
        game.renderGame();
        const renderEnvironmentReads = { ...reads };
        reads.safeAreaStyles = 0;
        reads.pointerMediaQueries = 0;
        canvasCalls = {};
        textCalls.length = 0;
        record = true;
        const layout = hudLayoutForCanvas(viewport);
        const expectedLayout = computeHudLayout(viewport, {
          touchControls: options.viewport !== 'desktop',
          safeArea: {
            top: options.viewport === 'touch-portrait' ? 47 : 0,
            right: 0,
            bottom: options.viewport === 'touch-portrait' ? 34 : 0,
            left: 0,
          },
        });
        if (JSON.stringify(layout) !== JSON.stringify(expectedLayout)) {
          throw new Error('HUD ignored viewport or safe area');
        }
        drawMiniMap(
          ctx,
          layout,
          local.ship,
          belt.getRoids(),
          LootField.getInstance().getAll(),
          SatellitePickupManager.getInstance().getAll(),
          []
        );
        drawScoreOverlay(ctx, layout, viewport, local.score);
        drawTextOverlay(ctx, layout, viewport, 'You were killed by an asteroid', 1);
        const rival = entityFactory.createRemotePlayer(
          'benchmark-rival',
          'Benchmark Rival',
          { x: 0, y: 0 },
          '#55aaff'
        );
        drawLeaderboard(ctx, layout, [local, rival], local.id);
        record = false;
        if (
          !textCalls.some((text) => text.includes('killed by')) ||
          !textCalls.some((text) => text.includes('Benchmark')) ||
          (canvasCalls['canvas.fillText'] ?? 0) < 2
        ) {
          throw new Error('HUD text and overlay were not submitted to the real canvas');
        }
        untimed['hud'] = { layout, text: [...textCalls] };
        const hudCalls = canvasCalls;
        const hudEnvironmentReads = { ...reads };
        canvasCalls = {};
        record = true;
        drawFieryBoundary({ x: 0, y: 0 });
        record = false;
        const centered = canvasCalls;
        canvasCalls = {};
        record = true;
        const boundary = getGameBoundary();
        drawFieryBoundary({ x: boundary.cx + boundary.radius, y: boundary.cy });
        record = false;
        if (
          (centered['canvas.arc'] ?? 0) !== 0 ||
          canvasCalls['canvas.arc'] !== 1 ||
          canvasCalls['canvas.stroke'] !== 1
        ) {
          throw new Error('Arena boundary must cull at center and draw at its visible edge');
        }
        untimed['arenaBoundary'] = {
          centeredCulled: (centered['canvas.arc'] ?? 0) === 0,
          visibleEdgeDrawn: canvasCalls['canvas.arc'] === 1 && canvasCalls['canvas.stroke'] === 1,
        };
        for (const [prefix, counts] of [
          ['untimed.renderGame.environment', renderEnvironmentReads],
          ['untimed.hud.environment', hudEnvironmentReads],
          ['untimed.hud', hudCalls],
          ['untimed.arenaBoundary.centered', centered],
          ['untimed.arenaBoundary.edge', canvasCalls],
        ] satisfies [string, Record<string, number>][]) {
          for (const [name, count] of Object.entries(counts)) {
            untimedCounts[`${prefix}.${name}`] = count;
          }
        }
        if (
          (measuredCalls['canvas.stroke'] ?? 0) === 0 ||
          (measuredCalls['canvas.fillText'] ?? 0) === 0
        ) {
          throw new Error('Observation context submitted no world or HUD work');
        }
      }
      if (local.id !== network.getLocalPlayerId()) {
        throw new Error('Local renderer identity changed during measurement');
      }
      if (network.isConnected || state.getIsGameRunning()) {
        throw new Error('Fixture started an unowned game loop or connection');
      }
      return {
        samples,
        counts: {
          frames: options.measuredFrames,
          updateCalls: options.measuredFrames,
          renderCalls: options.measuredFrames,
          players: 1,
          remotePlayers: network.getRemotePlayers().length,
          asteroids: after.asteroids.length,
          loot: after.loot.length,
          satellitePickups: after.pickups.length,
          visibleActorsExcludingPilot: visibleActors + spiders.length,
          ...(scene === 'stationary'
            ? {}
            : {
                terrainSpiders: spiders.length,
                visibleTerrainSpiders: spiders.length,
                abilityActivations: activateCalls,
              }),
          canvasRendererFrames: rendererFrames.canvas,
          webgl2RendererFrames: rendererFrames.webgl2,
          ...measuredCalls,
          ...untimedCounts,
        },
        witness: { before, after, untimed },
        frameWork,
        frameImageSha256,
        observationCaptures,
        canvasAttributes: ctx.getContextAttributes(),
        rendererBackend: observedBackend,
        gpuFrameStats: observedGpuStats,
      };
    } catch (error) {
      operationFailures.push(error);
      return undefined;
    }
  })();
  const cleanupFailures: unknown[] = [];
  restores.push(() => {
    window.Audio = NativeAudio;
    Date.now = originalNow;
    Math.random = originalRandom;
  });
  for (const restore of restores.reverse()) {
    try {
      restore();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (operationFailures.length || cleanupFailures.length) {
    throw new AggregateError(
      [...operationFailures, ...cleanupFailures],
      `Fixture execution or restoration failed: ${[...operationFailures, ...cleanupFailures].map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`
    );
  }
  if (!result) {
    throw new Error('Client fixture completed without a result');
  }
  return result;
}

export type ClientFixtureResult = Awaited<ReturnType<typeof runClientFixture>>;
declare global {
  interface Window {
    runClientFixture: typeof runClientFixture;
  }
}
window.runClientFixture = runClientFixture;
