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

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test.each(['Shift', 'right-click'])(
  '%s boost raises Scout cruise and a second press returns to downhill cruise',
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
    await game.placeShipAt(-2200, 650);
    await game.armSpawnProtection();
    await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      ship.angle = Math.PI;
    });
    await game.waitForAnimationFrames(24);
    const downhillCap = SHIP.MAX_VELOCITY * (1 + TERRAIN.DESCENT_SPEED_BONUS);

    const cruise = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return Math.hypot(ship.velocity.x, ship.velocity.y);
    });
    expect(cruise).toBeGreaterThan(SHIP.MAX_VELOCITY);
    expect(cruise).toBeLessThanOrEqual(downhillCap + 1e-6);

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
          return ship.boosting && ship.speed > downhillCap;
        },
        { message: 'Boost should stack with downhill speed' }
      )
      .toBe(true);

    const boosted = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return Math.hypot(ship.velocity.x, ship.velocity.y);
    });
    expect(boosted).toBeLessThanOrEqual(downhillCap * getShipKit('scout').boostMultiplier + 1e-6);

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
          return !ship.boosting && ship.speed <= downhillCap + 1e-6;
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
          { id: 'controls', text: 'Right-click toggles Boost on,' },
          { id: 'terrain', text: 'Boost stacks with downhill speed' },
          { id: 'hauler', text: 'a cable winch and hook' },
          { id: 'scout', text: 'The sweep is a visual cue' },
          { id: 'asteroids', text: 'roughly four drifting rocks' },
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
