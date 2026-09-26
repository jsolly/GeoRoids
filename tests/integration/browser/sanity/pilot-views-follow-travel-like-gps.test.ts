import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { CIVIC_LOTS } from '../../../../shared/furnaces';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';
import { canvasPoint, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

function paintedCircles(page: Page) {
  return page.evaluate(async () => {
    const circles: { canvas: string; x: number; y: number; radius: number }[] = [];
    const original = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (
      this: CanvasRenderingContext2D,
      x,
      y,
      radius,
      start,
      end,
      counterclockwise
    ) {
      const transform = this.getTransform();
      const ratio = this.canvas.getBoundingClientRect().width / this.canvas.width;
      circles.push({
        canvas: this.canvas.id,
        x: (transform.a * x + transform.c * y + transform.e) * ratio,
        y: (transform.b * x + transform.d * y + transform.f) * ratio,
        radius: radius * Math.hypot(transform.a, transform.b) * ratio,
      });
      original.call(this, x, y, radius, start, end, counterclockwise);
    };
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    } finally {
      CanvasRenderingContext2D.prototype.arc = original;
    }
    return circles;
  });
}

test.each([
  { width: 1280, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
])(
  'travel turns the viewport and both maps on $width × $height',
  async ({ width, height, touch }) => {
    const page = touch
      ? await browserManager.recreatePage({ hasTouch: true })
      : browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Missing GPS pilot page');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height });
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    await arrangeCrewField([await game.getLocalPlayerId()], 'empty');
    const readCamera = await page.evaluateHandle<
      () => { rotation: number; aheadX: number; aheadY: number; speed: number; angle: number }
    >(
      `import('/src/rendering/canvasSurface.ts').then(({ canvasManager }) => () => {
      const ship = window.gameController.getCurrPlayer().ship;
      const ahead = canvasManager.worldToScreen({ x: ship.position.x + ship.velocity.x * 40, y: ship.position.y + ship.velocity.y * 40 }, ship.position);
      const viewport = canvasManager.getViewportSize();
      return { rotation: canvasManager.getCameraRotation(), aheadX: ahead.x - viewport.width / 2, aheadY: ahead.y - viewport.height / 2, speed: Math.hypot(ship.velocity.x, ship.velocity.y), angle: ship.angle };
    })`
    );
    try {
      const initial = await readCamera.evaluate((read) => read());
      const touchSession = touch ? await page.context().newCDPSession(page) : null;
      if (touchSession) {
        const point = await canvasPoint(page, 0.85, 0.5);
        await dispatchTouch(touchSession, 'touchStart', [{ id: 1, ...point }]);
      } else {
        await page.keyboard.down('ArrowRight');
      }
      await expect
        .poll(async () => {
          const state = await readCamera.evaluate((read) => read());
          return Math.abs(
            Math.atan2(
              Math.sin(state.rotation - initial.rotation),
              Math.cos(state.rotation - initial.rotation)
            )
          );
        })
        .toBeGreaterThan(0.7);
      if (touchSession) {
        await dispatchTouch(touchSession, 'touchEnd', []);
        await touchSession.detach();
      } else {
        await page.keyboard.up('ArrowRight');
      }
      await expect
        .poll(async () => (await readCamera.evaluate((read) => read())).speed)
        .toBeGreaterThan(0.1);
      const moving = await readCamera.evaluate((read) => read());
      // Rendering and simulation can straddle one frame; allow less than a ship-width of error.
      expect(Math.abs(moving.aheadX)).toBeLessThan(12);
      expect(moving.aheadY).toBeLessThan(-5);
      expect(Math.abs(moving.rotation - initial.rotation)).toBeGreaterThan(0.3);
      await page.keyboard.press('Space');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`gps-flight-${touch ? 'mobile' : 'desktop'}.png`),
      });

      if (touch) {
        await page.locator('#universe-map-toggle').tap();
      } else {
        await page.keyboard.press('KeyM');
      }
      await expect.poll(() => page.locator('#universe-map-dialog').isVisible()).toBe(true);
      const stoppedRotation = await readCamera.evaluate((read) => read().rotation);
      const compass = await page.locator('.universe-map-compass').evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return Math.atan2(matrix.b, matrix.a);
      });
      expect(Math.sin(compass - stoppedRotation)).toBeCloseTo(0, 3);
      await expect.poll(() => readCamera.evaluate((read) => read().speed)).toBe(0);
      expect(await readCamera.evaluate((read) => read().rotation)).toBeCloseTo(stoppedRotation, 3);
      const lot = CIVIC_LOTS.find((candidate) => candidate.name === 'Southeast Furnace I');
      if (!lot) {
        throw new Error('Missing GPS landmark');
      }
      const course = stoppedRotation + Math.PI / 2;
      await game.placeShipAt(
        lot.position.x - Math.cos(course) * 220,
        lot.position.y + Math.sin(course) * 220
      );
      await page.locator('#universe-map-center').click();
      const circles = await paintedCircles(page);
      const layout = await page.evaluate(() => {
        const canvas = document.querySelector('#gameCanvas');
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error('Missing flight canvas');
        }
        const rect = canvas.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      const flightMark = circles.find(
        (circle) =>
          circle.canvas === 'gameCanvas' &&
          Math.abs(circle.radius - lot.radius) < 0.1 &&
          Math.abs(circle.x - layout.width / 2) < 1 &&
          circle.y < layout.height / 2
      );
      expect(flightMark?.y).toBeCloseTo(layout.height / 2 - 220, 0);
      // The radar ring locates the HUD independently of projection helpers.
      const ring = circles.find(
        (circle) =>
          circle.canvas === 'gameCanvas' &&
          circle.x > layout.width * 0.6 &&
          circle.y > layout.height * 0.6 &&
          Math.abs(circle.radius - (touch ? 40 : 48)) < 0.1
      );
      expect(ring).toBeDefined();
      if (!ring) {
        throw new Error('Missing radar ring');
      }
      expect(
        circles.some(
          (circle) =>
            circle.canvas === 'gameCanvas' &&
            Math.abs(circle.radius - 4) < 0.1 &&
            Math.abs(circle.x - ring.x) < 1 &&
            circle.y < ring.y &&
            circle.y > ring.y - ring.radius
        )
      ).toBe(true);
      const mapSize = await page.locator('#universe-map-canvas').boundingBox();
      if (!mapSize) {
        throw new Error('Missing chart dimensions');
      }
      const chartMark = circles.find(
        (circle) =>
          circle.canvas === 'universe-map-canvas' &&
          Math.abs(circle.radius - 7.7) < 0.1 &&
          Math.abs(circle.x - mapSize.width / 2) < 1 &&
          circle.y < mapSize.height / 2
      );
      expect(chartMark).toBeDefined();
      if (!chartMark) {
        throw new Error('Missing rendered chart landmark');
      }
      await page.locator('#universe-map-zoom-in').click();
      const zoomed = await paintedCircles(page);
      const zoomedMark = zoomed.find(
        (circle) =>
          circle.canvas === 'universe-map-canvas' &&
          Math.abs(circle.radius - 7.7) < 0.1 &&
          Math.abs(circle.x - mapSize.width / 2) < 1 &&
          circle.y < mapSize.height / 2
      );
      expect(zoomedMark).toBeDefined();
      expect(mapSize.height / 2 - (zoomedMark?.y ?? 0)).toBeCloseTo(
        (mapSize.height / 2 - chartMark.y) * 1.35,
        1
      );
      const mapBox = await page.locator('#universe-map-canvas').boundingBox();
      if (!mapBox) {
        throw new Error('Missing map canvas');
      }
      const center = { x: mapBox.x + mapBox.width / 2, y: mapBox.y + mapBox.height / 2 };
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + 60, center.y + 40, { steps: 5 });
      await page.mouse.up();
      expect(await page.locator('#universe-map-center').getAttribute('aria-pressed')).toBe('false');
      await page.locator('#universe-map-center').click();
      expect(await page.locator('#universe-map-center').getAttribute('aria-pressed')).toBe('true');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`gps-map-${touch ? 'mobile' : 'desktop'}.png`),
      });
      await page.locator('#universe-map-close').click();
      await expect.poll(() => readCamera.evaluate((read) => read().speed)).toBeGreaterThan(0.1);
      assertNoBrowserDiagnostics(diagnostics);
    } finally {
      await readCamera.dispose();
    }
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
