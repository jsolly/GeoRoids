import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'laser collision priority works correctly',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForCombatReady();
    await game.waitForAsteroids(1);

    const scoreBefore = await game.getScore();
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
    const asteroid = asteroids
      .filter(
        (candidate) =>
          candidate.isCollabTarget !== true && candidate.material === 'ice' && candidate.radius < 40
      )
      .map((candidate) => ({
        ...candidate,
        clearance: hazards.length
          ? Math.min(
              ...hazards.map((position) =>
                Math.hypot(candidate.x - position.x, candidate.y - position.y)
              )
            )
          : Number.MAX_SAFE_INTEGER,
      }))
      .sort((left, right) => right.clearance - left.clearance)[0];
    expect(
      asteroid,
      'expected a non-reflective ordinary asteroid clear of hostile actors'
    ).toBeDefined();
    if (!asteroid) {
      return;
    }

    await game.destroyAsteroidWithLaser(asteroid, 25000);

    await expect
      .poll(() => game.getScore(), {
        timeout: 8000,
        message: 'laser should register asteroid hit before expiring',
      })
      .toBeGreaterThan(scoreBefore);
  },
  TestConfig.DEFAULT_TIMEOUT
);
