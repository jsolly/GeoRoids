import { expect, test } from 'vitest';
import { PALETTE, ROID } from '../../../../src/constants';
import { getGameBoundary } from '../../../../src/physics/boundary';
import {
  drawingOffsets,
  PLAYFIELD_CLOSE_SCALE,
  projectWorldToScreen,
} from '../../../../src/rendering/playfieldCamera';
import { polygonPoints } from '../../../../src/rendering/vectorJuice';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
type Field = Awaited<ReturnType<GameInteractions['getAsteroidPositions']>>;

type BrowserPage = import('playwright').Page;

type BrowserErrors = {
  consoleErrors: string[];
  pageErrors: string[];
  dispose: () => void;
};

type CanvasPath = {
  points: Array<{ x: number; y: number }>;
  closed: boolean;
  strokeStyle: string;
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
  roidStrokeStyle: string;
  paths: CanvasPath[];
};

type AsteroidDrawEvidence = {
  canvas: { width: number; height: number };
  rockId: string;
  screen: { x: number; y: number };
  normalSilhouetteCount: number;
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
      const canvas = document.getElementById('gameCanvas');
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

async function pauseGame(page: BrowserPage): Promise<boolean> {
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

async function captureAsteroidDraw(
  page: BrowserPage,
  targetId: string
): Promise<AsteroidDrawCapture> {
  return page.evaluate(
    ({ id, roidColor }) => {
      const gameController = window.gameController;
      const canvas = document.getElementById('gameCanvas');
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
      styleProbe.strokeStyle = roidColor;
      const roidStrokeStyle = String(styleProbe.strokeStyle).toLowerCase();

      const paths: CanvasPath[] = [];
      let activePoints: Array<{ x: number; y: number }> = [];
      let activeClosed = false;
      const original = {
        beginPath: CanvasRenderingContext2D.prototype.beginPath,
        closePath: CanvasRenderingContext2D.prototype.closePath,
        moveTo: CanvasRenderingContext2D.prototype.moveTo,
        lineTo: CanvasRenderingContext2D.prototype.lineTo,
        stroke: CanvasRenderingContext2D.prototype.stroke,
      };
      const isGameCanvas = (candidate: CanvasRenderingContext2D): boolean =>
        candidate.canvas === canvas;

      CanvasRenderingContext2D.prototype.beginPath = function (
        this: CanvasRenderingContext2D
      ): void {
        if (isGameCanvas(this)) {
          activePoints = [];
          activeClosed = false;
        }
        original.beginPath.call(this);
      };
      CanvasRenderingContext2D.prototype.moveTo = function (
        this: CanvasRenderingContext2D,
        x: number,
        y: number
      ): void {
        if (isGameCanvas(this)) {
          activePoints.push({ x, y });
        }
        original.moveTo.call(this, x, y);
      };
      CanvasRenderingContext2D.prototype.lineTo = function (
        this: CanvasRenderingContext2D,
        x: number,
        y: number
      ): void {
        if (isGameCanvas(this)) {
          activePoints.push({ x, y });
        }
        original.lineTo.call(this, x, y);
      };
      CanvasRenderingContext2D.prototype.closePath = function (
        this: CanvasRenderingContext2D
      ): void {
        if (isGameCanvas(this)) {
          activeClosed = true;
        }
        original.closePath.call(this);
      };
      CanvasRenderingContext2D.prototype.stroke = function (
        this: CanvasRenderingContext2D,
        ...args: [] | [Path2D]
      ): void {
        if (isGameCanvas(this)) {
          paths.push({
            points: [...activePoints],
            closed: activeClosed,
            strokeStyle: String(this.strokeStyle).toLowerCase(),
          });
        }
        Reflect.apply(original.stroke, this, args);
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
            roidStrokeStyle,
            paths,
          };
        } finally {
          roidBelt.roids = originalRoids;
        }
      } finally {
        CanvasRenderingContext2D.prototype.beginPath = original.beginPath;
        CanvasRenderingContext2D.prototype.closePath = original.closePath;
        CanvasRenderingContext2D.prototype.moveTo = original.moveTo;
        CanvasRenderingContext2D.prototype.lineTo = original.lineTo;
        CanvasRenderingContext2D.prototype.stroke = original.stroke;
      }
    },
    { id: targetId, roidColor: PALETTE.ROID }
  );
}

function identifyAsteroidDraw(capture: AsteroidDrawCapture): AsteroidDrawEvidence {
  const screen = projectWorldToScreen(
    capture.rock.position,
    capture.ship,
    capture.canvas,
    PLAYFIELD_CLOSE_SCALE
  );
  const outline = polygonPoints(
    screen.x,
    screen.y,
    capture.rock.r * PLAYFIELD_CLOSE_SCALE,
    capture.rock.angle,
    Math.max(capture.rock.vertices, 1),
    drawingOffsets(capture.rock.offsets)
  );
  const expectedStrokeStyle = capture.roidStrokeStyle;
  const normalSilhouetteCount = capture.paths.filter((path) => {
    if (
      !path.closed ||
      path.points.length !== outline.length ||
      path.strokeStyle !== expectedStrokeStyle
    ) {
      return false;
    }
    return path.points.every((point, index) => {
      const expected = outline[index];
      return (
        expected !== undefined &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        Math.hypot(point.x - expected.x, point.y - expected.y) <= 0.001
      );
    });
  }).length;

  return {
    canvas: capture.canvas,
    rockId: capture.rock.id,
    screen,
    normalSilhouetteCount,
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

async function parkOutsideBelt(game: GameInteractions, side: number): Promise<void> {
  // Leave the initial bot-combat area immediately, without disabling gameplay.
  const x = side * (ROID.FIELD_RADIUS + 500);
  expect(Math.abs(x) + (await game.getShipRadius())).toBeLessThan(getGameBoundary().radius);
  await game.placeShipAt(x, 0);
}

test(
  'second player sees a shared asteroid field and nearby rocks render at fixed camera sizes',
  async () => {
    const page1 = browserManager.getCurrentPage();
    if (!page1) {
      throw new Error('Page 1 not available');
    }
    const page1Errors = observeBrowserErrors(page1);
    let page2: BrowserPage | undefined;
    let page2Errors: BrowserErrors | undefined;
    const pausedGames: PausedGame[] = [];
    let cleanupFailures: unknown[] = [];

    try {
      page2 = await browserManager.createPage();
      page2Errors = observeBrowserErrors(page2);
      const game1 = new GameInteractions(page1);
      const game2 = new GameInteractions(page2);

      // Install both observers before either browser joins the shared world.
      await game1.bootGame({ waitForCombatReady: false });
      await parkOutsideBelt(game1, 1);
      await game2.bootGame({ waitForCombatReady: false });
      await parkOutsideBelt(game2, -1);

      // Compare contemporary observations. Destruction/splitting may legitimately
      // change the field while the second browser boots or between network ticks.
      await expect
        .poll(
          async () => {
            const [first, second] = await Promise.all([
              game1.getAsteroidPositions(),
              game2.getAsteroidPositions(),
            ]);
            if (!first.length || first.length !== second.length) {
              return false;
            }
            return first.every((rock) => {
              const peer = second.find((other) => other.id === rock.id);
              return (
                peer !== undefined &&
                Math.abs(peer.x - rock.x) < 80 &&
                Math.abs(peer.y - rock.y) < 80
              );
            });
          },
          { timeout: 5000, message: 'both clients should share current asteroid IDs and poses' }
        )
        .toBe(true);

      const firstField = await game1.getAsteroidPositions();
      await expect
        .poll(async () => survivingRockMoved(firstField, await game1.getAsteroidPositions()), {
          timeout: 2500,
          message: 'existing shared asteroids should keep moving',
        })
        .toBe(true);

      // Place both cameras near the same surviving rock, choosing the greatest
      // clearance from live NPCs and leaving space outside its hull.
      const [field, bots, satellites, radius1, radius2] = await Promise.all([
        game1.getAsteroidPositions(),
        game1.getBots(),
        game1.getSatellites(),
        game1.getShipRadius(),
        game2.getShipRadius(),
      ]);
      const enemies = [...bots, ...satellites].filter(
        (enemy) => !enemy.exploding && enemy.health > 0
      );
      const clearance = (rock: Field[number]) =>
        Math.min(...enemies.map((enemy) => Math.hypot(enemy.x - rock.x, enemy.y - rock.y)));
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
            evidence.normalSilhouetteCount,
            `${label} should issue a closed Canvas silhouette for the identified rock`
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
