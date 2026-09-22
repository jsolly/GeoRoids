import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager } = createBrowserScenarioHooks();

test(
  'score persists after respawn',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();
    await arrangeCrewField([await game.getLocalPlayerId()], 'mining');
    await game.waitForCombatReady();
    await game.placeShipAt(0, -500);
    await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Mining fixture pilot missing');
      }
      ship.angle = Math.PI / 2;
    });
    await expect
      .poll(async () => (await game.getAsteroidPositions()).map((rock) => rock.id))
      .toEqual(['crew-fixture-ore']);
    const livesBeforeScore = await game.getLives();
    const scoreBefore = await game.getScore();
    await page.keyboard.press('Space');

    await expect
      .poll(() => game.getScore(), {
        timeout: 8000,
        message: 'destroying an asteroid should award points',
      })
      .toBeGreaterThan(scoreBefore);
    expect(await game.getLives(), 'earning the score should not spend a life').toBe(
      livesBeforeScore
    );

    const scoreBeforeDeath = await game.getScore();
    const livesBeforeDeath = await game.getLives();
    await game.dieOnceViaBoundary();

    expect(
      await game.getLives(),
      'the boundary death should reach the respawn lifecycle'
    ).toBeLessThan(livesBeforeDeath);
    await expect
      .poll(() => game.getScore(), { timeout: 8000, message: 'score should survive respawn' })
      .toBe(scoreBeforeDeath);
  },
  TestConfig.DEFAULT_TIMEOUT
);
