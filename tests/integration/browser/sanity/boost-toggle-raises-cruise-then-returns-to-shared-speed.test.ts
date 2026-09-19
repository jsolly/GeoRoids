import { expect, test } from 'vitest';
import { SHIP } from '../../../../src/constants';
import { getShipKit } from '../../../../src/entities/ship/shipKits';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test.each(['Shift', 'right-click'])(
  '%s boost raises Surveyor cruise and a second press returns to the shared cap',
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
    await game.bootGame({ waitForCombatReady: false, kitId: 'surveyor' });
    await game.waitForAnimationFrames(24);

    const cruise = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return Math.hypot(ship.velocity.x, ship.velocity.y);
    });
    expect(cruise).toBeGreaterThan(0);
    expect(cruise).toBeLessThanOrEqual(SHIP.MAX_VELOCITY + 1e-6);

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
          return ship.boosting && ship.speed > SHIP.MAX_VELOCITY;
        },
        { message: 'Surveyor boost should exceed the shared cruise cap' }
      )
      .toBe(true);

    const boosted = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return Math.hypot(ship.velocity.x, ship.velocity.y);
    });
    expect(boosted).toBeLessThanOrEqual(
      SHIP.MAX_VELOCITY * getShipKit('surveyor').boostMultiplier + 1e-6
    );

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
          return !ship.boosting && ship.speed <= SHIP.MAX_VELOCITY + 1e-6;
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
          { id: 'hauler', text: 'a cable winch and hook' },
          { id: 'surveyor', text: 'The sweep is a visual cue' },
          { id: 'asteroids', text: 'Fresh sectors mix equal numbers' },
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
