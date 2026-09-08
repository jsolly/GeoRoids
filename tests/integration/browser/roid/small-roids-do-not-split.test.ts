import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

// Scenario: a solo laser finish of a biggest asteroid removes it and does not
// produce smaller pieces. Smaller classes never split either.
test(
  'small roids do not split',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);

    await game.navigateToGame();
    await game.waitForGameToLoad();
    await game.waitForGameReady();
    await game.waitForAsteroids(1);

    const before = await game.getAsteroidPositions();
    const large = before.find((a) => a.radius >= 40 && !a.isCollabTarget && a.material === 'ice');
    expect(large).toBeTruthy();
    if (!large) {
      return;
    }

    const countBefore = before.length;
    await game.destroyAsteroidWithLaser(large);

    await expect
      .poll(() => game.getAsteroidCount(), {
        timeout: 8000,
        message: 'destroying a large asteroid solo should reduce the count (no split)',
      })
      .toBeLessThan(countBefore);
  },
  TestConfig.DEFAULT_TIMEOUT
);
