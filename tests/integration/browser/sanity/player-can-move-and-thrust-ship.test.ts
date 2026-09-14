import { expect, test } from 'vitest';
import { SHIP } from '../../../../src/constants';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'player moves automatically and can steer with the keyboard',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();

    const startPos = await game.getShipPosition();
    const startAngle = await game.getShipAngle();

    await game.waitForAnimationFrames(24);
    const afterThrust = await game.getShipPosition();
    expect(Math.hypot(afterThrust.x - startPos.x, afterThrust.y - startPos.y)).toBeGreaterThan(5);
    const cruiseSpeed = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return Math.hypot(ship.velocity.x, ship.velocity.y);
    });
    expect(cruiseSpeed).toBeGreaterThan(0);
    expect(cruiseSpeed).toBeLessThanOrEqual(SHIP.MAX_VELOCITY + 1e-6);

    await game.holdMovementKey('ArrowRight', 400);
    const afterTurn = await game.getShipAngle();
    expect(Math.abs(afterTurn - startAngle)).toBeGreaterThan(0.05);
  },
  TestConfig.DEFAULT_TIMEOUT
);
