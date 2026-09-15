import { expect, test } from 'vitest';
import { SHIP } from '../../../../src/constants';
import { getShipKit } from '../../../../src/entities/ship/shipKits';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'Shift boost raises Surveyor cruise and a second press returns to the shared cap',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

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

    await page.keyboard.press('ShiftLeft');
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

    await page.keyboard.press('ShiftLeft');
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
        { message: 'A second Shift press should restore cruise' }
      )
      .toBe(true);
  },
  TestConfig.DEFAULT_TIMEOUT
);
