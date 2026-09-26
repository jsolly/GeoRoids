import { expect, test } from 'vitest';
import { SHIP } from '../../../../src/constants';
import { getShipKit } from '../../../../src/entities/ship/shipKits';
import { TERRAIN } from '../../../../src/physics/terrain/terrainConfig';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';
import { centerOf } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test.each(['Shift', 'right-click'])(
  '%s boost raises Scout cruise and a second press returns to contour cruise',
  async (input) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const toggleBoost = async () => {
      if (input === 'Shift') {
        await page.keyboard.press('ShiftLeft');
      } else {
        await page.locator('#gameCanvas').click({ button: 'right' });
      }
    };
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    await arrangeCrewField([await game.getLocalPlayerId()], 'empty');
    await game.placeShipAt(1700, 3600);
    await game.armSpawnProtection();
    const heading = await page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller unavailable');
      }
      const { gradient } = gc.getTerrainProbe({ x: 1700, y: 3600 });
      return Math.atan2(-gradient.y, gradient.x) + Math.PI / 2;
    });
    const center = await centerOf(page, '#gameCanvas');
    const camera = await page.evaluateHandle<
      typeof import('../../../../src/rendering/canvasSurface').canvasManager
    >("import('/src/rendering/canvasSurface.ts').then(module => module.canvasManager)");
    try {
      await expect
        .poll(
          async () => {
            const state = await camera.evaluate((surface) => {
              const ship = window.gameController?.getCurrPlayer()?.ship;
              if (!ship) {
                throw new Error('Missing boost pilot');
              }
              return { rotation: surface.getCameraRotation(), angle: ship.angle };
            });
            const error = Math.atan2(
              Math.sin(heading - state.angle),
              Math.cos(heading - state.angle)
            );
            const correction = Math.max(-0.5, Math.min(0.5, error * 0.4));
            const screenAngle = state.angle + correction - state.rotation;
            await page.mouse.move(
              center.x + Math.cos(screenAngle) * 300,
              center.y - Math.sin(screenAngle) * 300
            );
            await game.waitForAnimationFrames(1);
            await page.mouse.move(center.x, center.y);
            const angle = await game.getShipAngle();
            return Math.abs(Math.atan2(Math.sin(angle - heading), Math.cos(angle - heading)));
          },
          { timeout: 5000, interval: 16 }
        )
        .toBeLessThan(0.01);
    } finally {
      await page.mouse.move(center.x, center.y);
      await camera.dispose();
    }
    await game.placeShipAt(1700, 3600);
    await game.armSpawnProtection();
    await game.waitForAnimationFrames(30);
    const contourCap = SHIP.MAX_VELOCITY * (1 + TERRAIN.CONTOUR_SPEED_BONUS);

    const cruise = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return Math.hypot(ship.velocity.x, ship.velocity.y);
    });
    expect(cruise).toBeGreaterThan(SHIP.MAX_VELOCITY);
    expect(cruise).toBeLessThanOrEqual(contourCap + 1e-6);

    await toggleBoost();
    await expect
      .poll(
        async () => {
          const ship = await page.evaluate(() => {
            const local = window.gameController?.getCurrPlayer()?.ship;
            if (!local) {
              throw new Error('Local ship unavailable');
            }
            return {
              boosting: local.boosting,
              speed: Math.hypot(local.velocity.x, local.velocity.y),
            };
          });
          return ship.boosting && ship.speed > contourCap;
        },
        { message: 'Boost should stack with contour speed' }
      )
      .toBe(true);

    const boosted = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return Math.hypot(ship.velocity.x, ship.velocity.y);
    });
    expect(boosted).toBeLessThanOrEqual(contourCap * getShipKit('scout').boostMultiplier + 1e-6);

    if (input === 'right-click') {
      await page.screenshot({ path: screenshotManager.getScreenshotPath('boost-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: screenshotManager.getScreenshotPath('boost-mobile.png') });
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    await toggleBoost();
    await expect
      .poll(
        async () => {
          const ship = await page.evaluate(() => {
            const local = window.gameController?.getCurrPlayer()?.ship;
            if (!local) {
              throw new Error('Local ship unavailable');
            }
            return {
              boosting: local.boosting,
              speed: Math.hypot(local.velocity.x, local.velocity.y),
            };
          });
          return !ship.boosting && ship.speed <= contourCap + 1e-6;
        },
        { message: 'A second boost press should restore cruise' }
      )
      .toBe(true);

    if (input === 'right-click') {
      for (const viewport of [
        { name: 'desktop', width: 1280, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        for (const article of [
          { id: 'controls', text: 'right-click to toggle Boost' },
          { id: 'terrain', text: 'Boost stacks with the contour bonus' },
        ]) {
          await page.goto(`${TestConfig.GAME_URL}/wiki/#${article.id}`);
          await page.getByText(article.text, { exact: false }).waitFor();
          await page.screenshot({
            path: screenshotManager.getScreenshotPath(`boost-${article.id}-${viewport.name}.png`),
            fullPage: true,
          });
        }
      }
    }
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
