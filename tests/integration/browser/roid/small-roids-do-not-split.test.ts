import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

const SMALL_ROID_MAX_RADIUS = 20;

// Scenario: a solo laser finish of a small asteroid removes exactly that rock.
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
    const small = before.find(
      (asteroid) => asteroid.radius < SMALL_ROID_MAX_RADIUS && !asteroid.isCollabTarget
    );
    expect(small, 'expected at least one small asteroid in the field').toBeDefined();
    if (!small) {
      throw new Error('Small asteroid missing');
    }

    const countBefore = before.length;
    await game.destroyAsteroidWithLaser(small);

    await expect
      .poll(() => game.getAsteroidCount(), {
        timeout: 8000,
        message: 'destroying a small asteroid should remove exactly one rock (no split)',
      })
      .toBe(countBefore - 1);

    const remaining = await game.getAsteroidPositions();
    expect(
      remaining.some((asteroid) => asteroid.id === small.id),
      'the original small asteroid should be gone'
    ).toBe(false);
  },
  TestConfig.DEFAULT_TIMEOUT
);
