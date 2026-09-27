import { expect, test } from 'vitest';
import { CONTOUR_LOCK } from '../../../../shared/contourLock';
import { SHIP } from '../../../../src/constants';
import { TERRAIN } from '../../../../src/physics/terrain/terrainConfig';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { placePilotNearContour } from '../../utils/contour-lock';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';
import { centerOf } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test.each(['Shift', 'right-click'])(
  '%s ignores pointer and keyboard steering until explicit release',
  async (input) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    await arrangeCrewField([await game.getLocalPlayerId()], 'empty');
    const center = await centerOf(page, '#gameCanvas');
    await page.mouse.move(center.x + 250, center.y - 150);
    await placePilotNearContour(page, game);
    const toggle = async () => {
      if (input === 'Shift') {
        await page.keyboard.press('ShiftLeft');
      } else {
        await page.mouse.down({ button: 'right' });
        await page.mouse.up({ button: 'right' });
      }
    };
    await toggle();
    await page.waitForFunction(() => window.gameController?.getCurrPlayer()?.ship.contourLocked);
    const height = await page.evaluate(
      () => window.gameController?.getCurrPlayer()?.ship.contourLock?.height
    );
    await game.waitForAnimationFrames(90);
    const state = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return {
        height: ship.contourLock?.height,
        speed: Math.hypot(ship.velocity.x, ship.velocity.y),
      };
    });
    expect(state.height).toBe(height);
    const cruise = SHIP.MAX_VELOCITY * (1 + TERRAIN.CONTOUR_SPEED_BONUS);
    expect(state.speed).toBeGreaterThan(cruise);
    expect(state.speed).toBeLessThanOrEqual(cruise * CONTOUR_LOCK.speedMultiplier + 1e-6);
    await toggle();
    await page.waitForFunction(() => !window.gameController?.getCurrPlayer()?.ship.contourLocked);
    await toggle();
    await page.waitForFunction(() => window.gameController?.getCurrPlayer()?.ship.contourLocked);
    await page.mouse.move(center.x - 250, center.y);
    await page.keyboard.press('ArrowLeft');
    await game.waitForAnimationFrames(15);
    expect(
      await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.contourLocked)
    ).toBe(true);
    await toggle();
    await page.waitForFunction(() => !window.gameController?.getCurrPlayer()?.ship.contourLocked);
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      for (const article of ['controls', 'terrain']) {
        await page.goto(`${TestConfig.GAME_URL}/wiki/#${article}`);
        await page.getByText('Contour Lock', { exact: false }).first().waitFor();
        await page.screenshot({
          path: screenshotManager.getScreenshotPath(`contour-lock-${article}-${viewport.name}.png`),
          fullPage: true,
        });
      }
    }
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
