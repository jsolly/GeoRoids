import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

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
    await game.waitForCombatReady();
    await game.waitForAsteroids(1);

    const [asteroids, satellites, bots] = await Promise.all([
      game.getAsteroidPositions(),
      game.getSatellites(),
      game.getBots(),
    ]);
    const hazards = [
      ...satellites.map((satellite) => ({ x: satellite.x, y: satellite.y })),
      ...bots
        .filter((bot) => bot.health > 0 && !bot.exploding)
        .map((bot) => ({ x: bot.x, y: bot.y })),
    ];
    const target = asteroids
      .filter(
        (asteroid) =>
          asteroid.isCollabTarget !== true && asteroid.material === 'ice' && asteroid.radius < 40
      )
      .map((asteroid) => ({
        ...asteroid,
        clearance: hazards.length
          ? Math.min(
              ...hazards.map((position) =>
                Math.hypot(asteroid.x - position.x, asteroid.y - position.y)
              )
            )
          : Number.MAX_SAFE_INTEGER,
      }))
      .sort((left, right) => right.clearance - left.clearance)[0];
    expect(
      target,
      'an ordinary ice asteroid clear of hostile actors should be available'
    ).toBeDefined();
    if (!target) {
      return;
    }
    const livesBeforeScore = await game.getLives();
    const scoreBefore = await game.getScore();
    await game.destroyAsteroidWithLaser(target, 25000);

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
