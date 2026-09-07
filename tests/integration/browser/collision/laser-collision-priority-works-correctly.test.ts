import { test, expect } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('laser collision priority works correctly', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);
  await game.bootGame();
  await game.waitForCombatReady();
  await game.waitForAsteroids(1);

  const scoreBefore = await game.getScore();
  const asteroid = (await game.getAsteroidPositions()).find(
    (candidate) => candidate.isCollabTarget !== true && candidate.radius < 40
  );
  expect(asteroid, 'expected an ordinary asteroid smaller than the collab class').toBeDefined();
  if (!asteroid) return;

  await game.destroyAsteroidWithLaser(asteroid, 25000);

  await expect
    .poll(() => game.getScore(), { timeout: 8000, message: 'laser should register asteroid hit before expiring' })
    .toBeGreaterThan(scoreBefore);
}, TestConfig.DEFAULT_TIMEOUT);
