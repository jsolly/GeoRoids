import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

// Scenario: a solo player can finish a biggest asteroid, but it does not split.
test(
  'solo player destroying a large roid does not split',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);

    await game.bootGame();
    await game.waitForAsteroids(1, 30000);

    const asteroids = await game.getAsteroidPositions();
    const initialCount = asteroids.length;
    const large = asteroids.find(
      (a) => a.radius >= 40 && !a.isCollabTarget && a.material === 'ice'
    );
    expect(large, 'expected at least one large asteroid in the field').toBeTruthy();
    if (!large) {
      return;
    }

    await game.destroyAsteroidWithLaser(large);

    await expect
      .poll(() => game.getAsteroidCount(), {
        timeout: 8000,
        message: 'solo destroy of a large asteroid should remove it without fragments',
      })
      .toBeLessThan(initialCount);

    const remaining = await game.getAsteroidPositions();
    expect(
      remaining.some((a) => a.id === large.id),
      'the original large asteroid should be gone'
    ).toBe(false);
  },
  TestConfig.DEFAULT_TIMEOUT
);
