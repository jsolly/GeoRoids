import { expect, test } from 'vitest';
import { WORLD } from '../../../../shared/world';
import { PALETTE } from '../../../../src/constants';
import { getGameBoundary } from '../../../../src/physics/boundary';
import {
  PLAYFIELD_CLOSE_SCALE,
  projectWorldToScreen,
} from '../../../../src/rendering/playfieldCamera';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
type Field = Awaited<ReturnType<GameInteractions['getAsteroidPositions']>>;

type BrowserPage = import('playwright').Page;

type FieldObservation = {
  ship: { x: number; y: number };
  rocks: Array<Pick<Field[number], 'id' | 'x' | 'y'>>;
};

type BrowserErrors = {
  consoleErrors: string[];
  pageErrors: string[];
  dispose: () => void;
};

type CanvasImage = {
  transform: { a: number; b: number; c: number; d: number; e: number; f: number };
  destination: { x: number; y: number; width: number; height: number };
  width: number;
  height: number;
  alpha: number;
  outlineSamples: number;
  matchingOutlineSamples: number;
  centerAlpha: number;
  cornerAlpha: number;
};

type AsteroidDrawCapture = {
  canvas: { width: number; height: number };
  rock: {
    id: string;
    position: { x: number; y: number };
    r: number;
    angle: number;
    vertices: number;
    offsets: number[];
  };
  ship: { x: number; y: number };
  images: CanvasImage[];
};

type AsteroidDrawEvidence = {
  canvas: { width: number; height: number };
  rockId: string;
  screen: { x: number; y: number };
  rasterSilhouetteCount: number;
};

type PausedGame = { page: BrowserPage; wasRunning: boolean };

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

function observeBrowserErrors(page: BrowserPage): BrowserErrors {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const onConsole = (message: import('playwright').ConsoleMessage): void => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error: Error): void => {
    pageErrors.push(error.message);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return {
    consoleErrors,
    pageErrors,
    dispose: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

async function setViewportAndWait(page: BrowserPage, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    ({ expectedWidth, expectedHeight }) => {
      const canvas = document.querySelector('#gameCanvas');
      return (
        canvas instanceof HTMLCanvasElement &&
        canvas.width === expectedWidth &&
        canvas.height === expectedHeight
      );
    },
    { expectedWidth: width, expectedHeight: height },
    { timeout: 5000 }
  );
}

function pauseGame(page: BrowserPage): Promise<boolean> {
  return page.evaluate(() => {
    const gameController = window.gameController;
    if (!gameController) {
      throw new Error('Asteroid field fixture requires a game controller while pausing');
    }
    const state = gameController.getGameStateManager();
    const wasRunning = state.getIsGameRunning();
    state.setIsGameRunning(false);
    return wasRunning;
  });
}

async function renderFullFrame(page: BrowserPage): Promise<void> {
  await page.evaluate(() => {
    const gameController = window.gameController;
    if (!gameController) {
      throw new Error('Asteroid field fixture requires a game controller while rendering');
    }
    gameController.renderGame();
  });
}

function captureAsteroidDraw(page: BrowserPage, targetId: string): Promise<AsteroidDrawCapture> {
  return page.evaluate(
    ({ id, roidColor, scale }) => {
      const gameController = window.gameController;
      const canvas = document.querySelector('#gameCanvas');
      if (!gameController || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Asteroid field fixture requires a game controller and canvas');
      }
      if (!canvas.getContext('2d')) {
        throw new Error('Asteroid field fixture requires a 2D canvas context');
      }

      const local = gameController.getCurrPlayer();
      const roidBelt = gameController.getCurrRoidBelt();
      const roid = roidBelt.getRoids().find((candidate) => candidate.id === id);
      if (!local || !roid) {
        throw new Error(`Asteroid field fixture lost target rock ${id}`);
      }
      const styleProbe = document.createElement('canvas').getContext('2d');
      if (!styleProbe) {
        throw new Error('Asteroid field fixture requires a style probe context');
      }
      styleProbe.fillStyle = roidColor;
      styleProbe.fillRect(0, 0, 1, 1);
      const expectedColor = styleProbe.getImageData(0, 0, 1, 1).data;

      const images: CanvasImage[] = [];
      const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (
        this: CanvasRenderingContext2D,
        image: CanvasImageSource,
        ...coordinates: number[]
      ): void {
        // Forward the real draw before inspecting the bitmap used by this frame.
        Reflect.apply(originalDrawImage, this, [image, ...coordinates]);
        if (this.canvas !== canvas || !(image instanceof HTMLCanvasElement)) {
          return;
        }
        const [x, y, width, height] = coordinates;
        if (
          coordinates.length !== 4 ||
          x === undefined ||
          y === undefined ||
          width === undefined ||
          height === undefined ||
          width <= 0 ||
          height <= 0
        ) {
          return;
        }
        const source = image.getContext('2d');
        if (!source) {
          throw new Error('Drawn asteroid image has no readable 2D context');
        }
        const pixels = source.getImageData(0, 0, image.width, image.height).data;
        const pixelRatio = image.width / width;
        const offsets = roid.offsets.length > 0 ? roid.offsets : [1];
        const vertices = Math.max(roid.vertices, 1);
        const outline = Array.from({ length: vertices }, (_, index) => {
          const angle = (index * Math.PI * 2) / vertices;
          const radius = roid.r * scale * (offsets[index] ?? 1) * pixelRatio;
          return {
            x: image.width / 2 + radius * Math.cos(angle),
            y: image.height / 2 + radius * Math.sin(angle),
          };
        });
        // Check the polygon edges as well as its vertices. A blank bitmap, wrong
        // shape or filled rectangle must not count as a visible asteroid outline.
        const samples = outline.flatMap((point, index) => {
          const next = outline[(index + 1) % outline.length];
          if (!next) {
            throw new Error('Asteroid outline lost its closing edge');
          }
          return [point, { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }];
        });
        const matchingOutlineSamples = samples.filter((point) => {
          for (let py = Math.floor(point.y) - 1; py <= Math.floor(point.y) + 1; py++) {
            for (let px = Math.floor(point.x) - 1; px <= Math.floor(point.x) + 1; px++) {
              if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
                continue;
              }
              const offset = (py * image.width + px) * 4;
              if (
                (pixels[offset + 3] ?? 0) >= 64 &&
                [0, 1, 2].every(
                  (channel) =>
                    Math.abs((pixels[offset + channel] ?? 0) - (expectedColor[channel] ?? 0)) <= 4
                )
              ) {
                return true;
              }
            }
          }
          return false;
        }).length;
        const transform = this.getTransform();
        const centerOffset =
          (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
        images.push({
          transform: {
            a: transform.a,
            b: transform.b,
            c: transform.c,
            d: transform.d,
            e: transform.e,
            f: transform.f,
          },
          destination: { x, y, width, height },
          width: image.width,
          height: image.height,
          alpha: this.globalAlpha,
          outlineSamples: samples.length,
          matchingOutlineSamples,
          centerAlpha: pixels[centerOffset + 3] ?? 255,
          cornerAlpha: pixels[3] ?? 255,
        });
      };

      try {
        // Use the normal render pipeline while isolating the identified rock;
        // drawRoidsRelative then reaches the real Canvas methods.
        const originalRoids = roidBelt.roids;
        roidBelt.roids = [roid];
        try {
          gameController.renderGame();
          return {
            canvas: { width: canvas.width, height: canvas.height },
            rock: {
              id: roid.id,
              position: { x: roid.position.x, y: roid.position.y },
              r: roid.r,
              angle: roid.angle,
              vertices: roid.vertices,
              offsets: [...roid.offsets],
            },
            ship: { x: local.ship.position.x, y: local.ship.position.y },
            images,
          };
        } finally {
          roidBelt.roids = originalRoids;
        }
      } finally {
        CanvasRenderingContext2D.prototype.drawImage = originalDrawImage;
      }
    },
    { id: targetId, roidColor: PALETTE.ROID, scale: PLAYFIELD_CLOSE_SCALE }
  );
}

function identifyAsteroidDraw(capture: AsteroidDrawCapture): AsteroidDrawEvidence {
  const screen = projectWorldToScreen(
    capture.rock.position,
    capture.ship,
    capture.canvas,
    PLAYFIELD_CLOSE_SCALE
  );
  const close = (actual: number, expected: number) => Math.abs(actual - expected) <= 0.001;
  const rasterSilhouetteCount = capture.images.filter((image) => {
    const { transform, destination } = image;
    return (
      close(transform.a, Math.cos(capture.rock.angle)) &&
      close(transform.b, Math.sin(capture.rock.angle)) &&
      close(transform.c, -Math.sin(capture.rock.angle)) &&
      close(transform.d, Math.cos(capture.rock.angle)) &&
      close(transform.e, screen.x) &&
      close(transform.f, screen.y) &&
      close(destination.x, -destination.width / 2) &&
      close(destination.y, -destination.height / 2) &&
      image.width === image.height &&
      close(image.alpha, 1) &&
      image.outlineSamples >= 6 &&
      image.matchingOutlineSamples === image.outlineSamples &&
      image.centerAlpha < 64 &&
      image.cornerAlpha === 0
    );
  }).length;

  return {
    canvas: capture.canvas,
    rockId: capture.rock.id,
    screen,
    rasterSilhouetteCount,
  };
}

function assertNoBrowserErrors(label: string, errors: BrowserErrors): void {
  expect(errors.consoleErrors, `${label} console errors`).toEqual([]);
  expect(errors.pageErrors, `${label} page errors`).toEqual([]);
}

function survivingRockMoved(before: Field, after: Field): boolean {
  return before.some((start) => {
    const later = after.find((rock) => rock.id === start.id);
    return later !== undefined && Math.hypot(later.x - start.x, later.y - start.y) > 1;
  });
}

function observeField(page: BrowserPage): Promise<FieldObservation> {
  return page.evaluate(() => {
    const controller = window.gameController;
    const local = controller?.getCurrPlayer();
    if (!controller || !local) {
      throw new Error('Shared field observation requires a local pilot');
    }
    return {
      ship: { x: local.ship.position.x, y: local.ship.position.y },
      rocks: controller
        .getCurrRoidBelt()
        .getRoids()
        .map((rock) => ({ id: rock.id, x: rock.position.x, y: rock.position.y })),
    };
  });
}

function compareSharedField(first: FieldObservation, second: FieldObservation) {
  const poseTolerance = 80;
  // Each recipient has its own interest square. Stay one pose tolerance inside
  // both edges so movement between snapshots cannot change expected membership.
  const insideSharedRegion = (rock: FieldObservation['rocks'][number]) =>
    [first.ship, second.ship].every(
      (ship) =>
        Math.abs(rock.x - ship.x) < WORLD.interestRadius - poseTolerance &&
        Math.abs(rock.y - ship.y) < WORLD.interestRadius - poseTolerance
    );
  const firstShared = first.rocks.filter(insideSharedRegion);
  const secondShared = second.rocks.filter(insideSharedRegion);
  const mismatches = (
    expected: FieldObservation['rocks'],
    received: FieldObservation['rocks']
  ): string[] => {
    const byId = new Map(received.map((rock) => [rock.id, rock]));
    return expected.flatMap((rock) => {
      const peer = byId.get(rock.id);
      return peer &&
        Math.abs(peer.x - rock.x) < poseTolerance &&
        Math.abs(peer.y - rock.y) < poseTolerance
        ? []
        : [rock.id];
    });
  };
  return {
    hasSharedField: firstShared.length > 0 && secondShared.length > 0,
    firstMissingOrDisplaced: mismatches(secondShared, first.rocks),
    secondMissingOrDisplaced: mismatches(firstShared, second.rocks),
  };
}

async function visitSharedSector(game: GameInteractions): Promise<void> {
  // A distant region separates the camera check from the launch area.
  await game.placeShipAt(20_000, 0);
}

test(
  'second player sees a shared asteroid field and nearby rocks render at fixed camera sizes',
  async () => {
    const page1 = browserManager.getCurrentPage();
    if (!page1) {
      throw new Error('Page 1 not available');
    }
    const page1Errors = observeBrowserErrors(page1);
    let page2Errors: BrowserErrors | undefined;
    const pausedGames: PausedGame[] = [];
    let cleanupFailures: unknown[] = [];

    try {
      const page2 = await browserManager.createPage();
      page2Errors = observeBrowserErrors(page2);
      const game1 = new GameInteractions(page1);
      const game2 = new GameInteractions(page2);

      // Install both observers before either browser joins the shared world.
      await game1.bootGame({ waitForCombatReady: false });
      await visitSharedSector(game1);
      await game2.bootGame({ waitForCombatReady: false });
      await visitSharedSector(game2);

      // Pilots cruise while the second browser boots, so their recipient fields
      // can differ at the edges. Compare every rock in their shared interior in
      // both directions, allowing network ticks and destruction to settle.
      await expect
        .poll(
          async () => {
            const [first, second] = await Promise.all([observeField(page1), observeField(page2)]);
            return compareSharedField(first, second);
          },
          { timeout: 5000, message: 'both clients should share current asteroid IDs and poses' }
        )
        .toEqual({
          hasSharedField: true,
          firstMissingOrDisplaced: [],
          secondMissingOrDisplaced: [],
        });

      const firstField = await game1.getAsteroidPositions();
      await expect
        .poll(async () => survivingRockMoved(firstField, await game1.getAsteroidPositions()), {
          timeout: 2500,
          message: 'existing shared asteroids should keep moving',
        })
        .toBe(true);

      // Place both cameras near the same surviving rock, choosing the greatest
      // clearance from live NPCs and leaving space outside its hull.
      const [field, pickups, radius1, radius2] = await Promise.all([
        game1.getAsteroidPositions(),
        game1.getSatellitePickups(),
        game1.getShipRadius(),
        game2.getShipRadius(),
      ]);
      const nearbyPilots = pickups.filter(
        (pickup) => pickup.health > 0 && pickup.state !== 'broken'
      );
      const clearance = (rock: Field[number]) =>
        Math.min(...nearbyPilots.map((pilot) => Math.hypot(pilot.x - rock.x, pilot.y - rock.y)));
      const focus = [...field].sort((a, b) => clearance(b) - clearance(a))[0];
      expect(focus, 'a surviving shared rock should be available for camera focus').toBeDefined();
      if (!focus) {
        throw new Error('No surviving shared rock was available for camera focus');
      }
      const outward = Math.atan2(focus.y, focus.x);
      const gap = focus.radius + Math.max(radius1, radius2) + 100;
      const pose = {
        x: focus.x + Math.cos(outward) * gap,
        y: focus.y + Math.sin(outward) * gap,
      };
      const separation = Math.max(radius1, radius2) + 30;
      const tangent = { x: -Math.sin(outward) * separation, y: Math.cos(outward) * separation };
      expect(Math.hypot(pose.x, pose.y) + separation + Math.max(radius1, radius2)).toBeLessThan(
        getGameBoundary().radius
      );
      await Promise.all([
        game1.placeShipAt(pose.x + tangent.x, pose.y + tangent.y),
        game2.placeShipAt(pose.x - tangent.x, pose.y - tangent.y),
      ]);

      await expect
        .poll(
          async () => {
            const [first, second] = await Promise.all([
              game1.getAsteroidPositions(),
              game2.getAsteroidPositions(),
            ]);
            return (
              first.some((rock) => rock.id === focus.id) &&
              second.some((rock) => rock.id === focus.id)
            );
          },
          { timeout: 2500, message: 'focused rock should remain available to both clients' }
        )
        .toBe(true);

      pausedGames.push({ page: page1, wasRunning: await pauseGame(page1) });
      pausedGames.push({ page: page2, wasRunning: await pauseGame(page2) });

      for (const viewport of VIEWPORTS) {
        await Promise.all([
          setViewportAndWait(page1, viewport.width, viewport.height),
          setViewportAndWait(page2, viewport.width, viewport.height),
        ]);
        const [capture1, capture2] = await Promise.all([
          captureAsteroidDraw(page1, focus.id),
          captureAsteroidDraw(page2, focus.id),
        ]);
        const draw1 = identifyAsteroidDraw(capture1);
        const draw2 = identifyAsteroidDraw(capture2);

        for (const [label, evidence] of [
          ['tab 1', draw1],
          ['tab 2', draw2],
        ] as const) {
          expect(evidence.rockId, `${label} should draw the identified shared rock`).toBe(focus.id);
          expect(evidence.canvas).toEqual({ width: viewport.width, height: viewport.height });
          expect(evidence.screen.x, `${label} target should be inside the canvas`).toBeGreaterThan(
            0
          );
          expect(evidence.screen.x, `${label} target should be inside the canvas`).toBeLessThan(
            viewport.width
          );
          expect(evidence.screen.y, `${label} target should be inside the canvas`).toBeGreaterThan(
            0
          );
          expect(evidence.screen.y, `${label} target should be inside the canvas`).toBeLessThan(
            viewport.height
          );
          expect(
            evidence.rasterSilhouetteCount,
            `${label} should draw the identified rock's visible outline at its projected pose`
          ).toBeGreaterThan(0);
        }

        await renderFullFrame(page1);
        const screenshotPath = screenshotManager.getScreenshotPath(
          `shared-asteroid-field-${viewport.name}.png`
        );
        await page1.screenshot({ path: screenshotPath });
      }

      assertNoBrowserErrors('page 1', page1Errors);
      if (!page2Errors) {
        throw new Error('Page 2 browser error observer was not installed');
      }
      assertNoBrowserErrors('page 2', page2Errors);
    } finally {
      const cleanupResults = await Promise.allSettled(
        pausedGames.map(({ page, wasRunning }) =>
          page.evaluate((running) => {
            const gameController = window.gameController;
            if (!gameController) {
              throw new Error('Asteroid field fixture lost its game controller during cleanup');
            }
            gameController.getGameStateManager().setIsGameRunning(running);
          }, wasRunning)
        )
      );
      page2Errors?.dispose();
      page1Errors.dispose();
      cleanupFailures = cleanupResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Asteroid field fixture cleanup failed');
    }
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
