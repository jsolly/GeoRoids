import { test, expect } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('laser hits and destroys asteroids', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);
  await game.bootGame();
  await game.waitForCombatReady();
  await game.waitForAsteroids(1);

  const initialScore = await game.getScore();
  const target = (await game.getAsteroidPositions()).find(
    (candidate) => candidate.isCollabTarget !== true && candidate.radius < 40
  );
  expect(target, 'expected an ordinary asteroid smaller than the collab class').toBeDefined();
  if (!target) return;

  await game.destroyAsteroidWithLaser(target, 25000);

  await expect
    .poll(
      async () => {
        await game.runGameFrames(8);
        const roids = await game.getAsteroidDetails();
        return !roids.some((r) => r.id === target.id);
      },
      { timeout: 12000, message: 'target asteroid should be gone (split fragments may remain)' }
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        await game.runGameFrames(8);
        return game.getScore();
      },
      { timeout: 12000, message: 'destroying an asteroid should award points' }
    )
    .toBeGreaterThan(initialScore);
}, TestConfig.DEFAULT_TIMEOUT);
