import pageMarkup from '../index.html?raw';
import '../index.css';
import { CLIENT_ID_STORAGE_KEY } from '../src/network/services/clientIdentity';

export interface ClientOptions {
  seed: number;
  warmupFrames: number;
  measuredFrames: number;
  viewport: 'desktop' | 'touch-portrait' | 'touch-landscape';
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
  const originalRandom = Math.random;
  const originalNow = Date.now;
  const NativeAudio = window.Audio;
  let randomState = options.seed >>> 0;
  let frame = 0;
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
      const { canvasManager } = await import('../src/rendering/canvas');
      const { Roid } = await import('../src/entities/roid/Roid');
      const { LootField } = await import('../src/entities/loot/LootField');
      const { SatelliteManager } = await import('../src/entities/satellite/SatelliteManager');
      const { SatellitePickupManager } = await import(
        '../src/entities/satellitePickup/SatellitePickupManager'
      );
      const { satelliteProfileAt } = await import('../shared/eoSatellites');
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
      game.newGame('Benchmark Pilot', 'hauler');
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
      const totalFrames = options.warmupFrames + options.measuredFrames;
      local.ship.shieldCooldown = totalFrames + 10;
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
          kind: 'wreckage',
        }))
      );
      const satellites = SatelliteManager.getInstance();
      satellites.syncFromServer(
        Array.from({ length: 3 }, (_, index) => {
          const profile = satelliteProfileAt(index);
          return {
            id: `benchmark-satellite-${index}`,
            name: profile.displayName,
            typeId: profile.typeId,
            assetKey: profile.assetKey,
            shotManner: profile.shotManner,
            position: { x: -75 + index * 75, y: -70 },
            velocity: { x: 0, y: 0 },
            angle: index,
            exploding: false,
            color: profile.hullColor,
            health: 100,
            maxHealth: 100,
            radius: 12,
          };
        })
      );
      const pickups = SatellitePickupManager.getInstance();
      pickups.syncFromServer(
        Array.from({ length: 3 }, (_, index) => ({
          id: `benchmark-pickup-${index}`,
          name: 'Echo',
          typeId: 'echo',
          assetKey: 'pickup/echo',
          position: { x: -75 + index * 75, y: 110 },
          velocity: { x: 0, y: 0 },
          angle: index,
          radius: 8,
          color: '#99ffaa',
          state: 'loose',
          ownerId: null,
          health: 50,
          maxHealth: 50,
        }))
      );
      state.clearOverlay();
      ensureTerrain(options.seed);
      setPlayView(true);
      syncTouchChrome(true);
      const probe = document.getElementById('safe-area-probe');
      if (!(probe instanceof HTMLElement)) {
        throw new Error('Safe-area probe is missing');
      }
      probe.style.padding = options.viewport === 'touch-portrait' ? '47px 0px 34px 0px' : '0px';
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const canvas = canvasManager.requireCanvas();
      const ctx = canvasManager.requireContext();
      if (
        !canvas.checkVisibility() ||
        document.visibilityState !== 'visible' ||
        canvas.width !== innerWidth ||
        canvas.height !== innerHeight ||
        navigator.maxTouchPoints > 0 !== (options.viewport !== 'desktop')
      ) {
        throw new Error('Canvas visibility, dimensions, or touch capability do not match fixture');
      }

      function snapshot() {
        return {
          local: {
            id: local.id,
            shipId: local.ship.id,
            position: { ...local.ship.position },
            health: local.ship.health,
            lives: local.lives,
            exploding: local.ship.exploding,
            shieldCooldown: local.ship.shieldCooldown,
          },
          asteroids: belt.roids.map((roid) => ({
            id: roid.id,
            position: { ...roid.position },
            health: roid.health,
            vertices: roid.vertices,
            offsets: [...roid.offsets],
          })),
          loot: loot.getAll().map((item) => ({ id: item.id, position: { ...item.position } })),
          satellites: satellites
            .getAll()
            .map((item) => ({ id: item.id, health: item.health, position: { ...item.position } })),
          pickups: pickups
            .getAll()
            .map((item) => ({ id: item.id, state: item.state, position: { ...item.position } })),
        };
      }
      const before = snapshot();
      let canvasCalls: Record<string, number> = {};
      const textCalls: string[] = [];
      let record = false;
      let phase: 'update' | 'render' = 'update';
      const frameWork: Array<Record<string, number>> = [];
      function countWork(name: string) {
        if (record) {
          const key = `${phase}.${name}`;
          canvasCalls[key] = (canvasCalls[key] ?? 0) + 1;
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
        restores.push(() => Object.defineProperty(target, key, { ...descriptor, value }));
      }
      if (options.observe) {
        for (const [kind, actors] of [
          ['localShip', [local.ship]],
          ['asteroid', belt.roids],
          ['loot', loot.getAll()],
          ['satellite', satellites.getAll()],
          ['pickup', pickups.getAll()],
        ] satisfies [string, readonly object[]][]) {
          for (const actor of actors) {
            observeRead(actor, 'position', `${kind}.positionReads`);
          }
        }
        for (const level of getTerrainContours()) {
          for (const segment of level.segments) {
            for (const key of ['ax', 'ay', 'bx', 'by']) {
              observeRead(segment, key, 'contour.endpointReads');
            }
          }
        }
        for (const [prefix, prototype] of [
          ['canvas', CanvasRenderingContext2D.prototype],
          ['path', Path2D.prototype],
        ] satisfies [string, object][]) {
          for (const key of Object.getOwnPropertyNames(prototype)) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
            const original: unknown = descriptor?.value;
            if (key === 'constructor' || typeof original !== 'function' || !descriptor) {
              continue;
            }
            Object.defineProperty(prototype, key, {
              ...descriptor,
              value: function (this: object, ...args: unknown[]) {
                if (record) {
                  const name = `${prefix}.${key}`;
                  countWork(name);
                  canvasCalls[name] = (canvasCalls[name] ?? 0) + 1;
                  if (key === 'fillText' && typeof args[0] === 'string') {
                    textCalls.push(args[0]);
                  }
                }
                return Reflect.apply(original, this, args);
              },
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
      await new Promise<void>((resolve, reject) => {
        const step = (timestamp: number) => {
          try {
            const measured = frame >= options.warmupFrames;
            record = options.observe && measured;
            const beforeWork = record ? { ...canvasCalls } : undefined;
            frame++;
            phase = 'update';
            countWork('calls');
            const start = performance.now();
            game.updateGame(FRAME_MS);
            const updated = performance.now();
            phase = 'render';
            countWork('calls');
            game.renderGame();
            const rendered = performance.now();
            if (measured && !options.observe) {
              if (previousRaf === undefined) {
                throw new Error('Missing preceding rAF callback');
              }
              samples.frameIntervalMs.push(timestamp - previousRaf);
              samples.updateMs.push(updated - start);
              samples.renderMs.push(rendered - updated);
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
            previousRaf = timestamp;
            if (frame < totalFrames) {
              requestAnimationFrame(step);
            } else {
              resolve();
            }
          } catch (error) {
            reject(error);
          }
        };
        requestAnimationFrame(step);
      });
      record = false;
      const frameImageSha256 = options.observe
        ? Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                ctx.getImageData(0, 0, canvas.width, canvas.height).data
              )
            ),
            (byte) => byte.toString(16).padStart(2, '0')
          ).join('')
        : null;
      const after = snapshot();
      if (
        after.local.health !== before.local.health ||
        after.local.lives !== before.local.lives ||
        after.local.exploding ||
        after.local.position.x !== 0 ||
        after.local.position.y !== 0 ||
        after.local.shieldCooldown !== 10 ||
        after.asteroids.length !== 24 ||
        after.loot.length !== 6 ||
        after.satellites.length !== 3 ||
        after.pickups.length !== 3
      ) {
        throw new Error('Visible fixture did not survive with its expected lifecycle outcome');
      }
      if (
        JSON.stringify(before.loot) !== JSON.stringify(after.loot) ||
        JSON.stringify(before.satellites) !== JSON.stringify(after.satellites) ||
        JSON.stringify(before.pickups) !== JSON.stringify(after.pickups)
      ) {
        throw new Error('Fixture lost or changed a stationary scene participant');
      }
      const visibleActors = [
        ...after.asteroids,
        ...after.loot,
        ...after.satellites,
        ...after.pickups,
      ].filter((actor) => {
        const screen = canvasManager.worldToScreen(actor.position, local.ship.position);
        return (
          screen.x >= 24 &&
          screen.y >= 24 &&
          screen.x <= canvas.width - 24 &&
          screen.y <= canvas.height - 24
        );
      }).length;
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
      const untimedCounts: Record<string, number> = {};
      if (options.observe) {
        const { hudLayoutForCanvas, computeHudLayout } = await import(
          '../src/rendering/hud/hudLayout'
        );
        const { drawScoreOverlay, drawTextOverlay } = await import('../src/rendering/hud/gameInfo');
        const { drawLivesIndicator } = await import('../src/rendering/hud/lives');
        const { drawMiniMap } = await import('../src/rendering/hud/minimap');
        const { drawLeaderboard } = await import('../src/rendering/hud/leaderboard');
        const { entityFactory } = await import('../src/entities/EntityFactory');
        const { PALETTE } = await import('../src/constants/index');
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
        const layout = hudLayoutForCanvas(canvas);
        const expectedLayout = computeHudLayout(canvas, {
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
          SatelliteManager.getInstance().getAll(),
          SatellitePickupManager.getInstance().getAll()
        );
        drawScoreOverlay(ctx, layout, canvas, local.score, local.lives, local.factionId);
        drawLivesIndicator(ctx, layout, local.lives, PALETTE.LOCAL, local.ship.kitId);
        drawTextOverlay(ctx, layout, canvas, 'Game Over: killed by Benchmark Rival', 1);
        const rival = entityFactory.createRemotePlayer(
          'benchmark-rival',
          'Benchmark Rival',
          { x: 0, y: 0 },
          '#55aaff'
        );
        drawLeaderboard(ctx, layout, [local, rival], local.id);
        record = false;
        if (
          !textCalls.includes('GAME OVER') ||
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
          humans: 1,
          bots: network.getAllPlayers().filter((player) => player.type === 'bot').length,
          remoteHumans: network.getRemotePlayers().length,
          asteroids: after.asteroids.length,
          loot: after.loot.length,
          satellites: after.satellites.length,
          satellitePickups: after.pickups.length,
          visibleActorsExcludingPilot: visibleActors,
          ...measuredCalls,
          ...untimedCounts,
        },
        witness: { before, after, untimed },
        frameWork,
        frameImageSha256,
        canvasAttributes: ctx.getContextAttributes(),
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
