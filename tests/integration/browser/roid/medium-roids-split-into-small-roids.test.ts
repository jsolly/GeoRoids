import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

// Scenario: medium asteroids are below the collab-split class and never split.
test('medium roids do not split', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);

  await game.bootGame();
  await game.waitForAsteroids(1);

  const initial = await game.getAsteroidPositions();
  const large = initial.find((a) => a.radius >= 40 && !a.isCollabTarget && a.material === 'ice');
  expect(large, 'expected a large asteroid').toBeTruthy();
  if (!large) return;

  // Solo finish of a large roid does not produce mediums.
  await game.destroyAsteroidWithLaser(large);

  const after = await game.getAsteroidPositions();
  const mediums = after.filter((a) => a.radius >= 25 && a.radius < 40);
  expect(mediums.length, 'solo large destroy should not create medium fragments').toBe(0);
}, TestConfig.DEFAULT_TIMEOUT);
