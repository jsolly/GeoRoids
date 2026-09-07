import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { bootTwoClientGames } from '../../utils/multi-client-setup';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

// Scenario: two players shoot the same biggest asteroid within 1s → it splits.
test('two players hit big roid within 1s → split', async () => {
  const { game1, game2 } = await bootTwoClientGames(browserManager);

  await game1.waitForAsteroids(1, 30000);
  const asteroids = await game1.getAsteroidPositions();
  const large = asteroids.find((a) => a.radius >= 40 && !a.isCollabTarget && a.material === 'ice');
  expect(large, 'expected at least one biggest asteroid in the field').toBeTruthy();
  if (!large) return;

  const initialCount = asteroids.length;
  const gap = large.radius + 40;

  await game1.placeShipAt(large.x - gap, large.y);
  await game2.placeShipAt(large.x + gap, large.y);
  await game1.syncShipPositionToServer();
  await game2.syncShipPositionToServer();
  await game1.armSpawnProtection();
  await game2.armSpawnProtection();

  await game1.fireLaserToward(large.x, large.y);
  await game2.fireLaserToward(large.x, large.y);

  await expect
    .poll(() => game1.getAsteroidCount(), {
      timeout: 8000,
      message: 'two players hitting a big roid within 1s should split it',
    })
    .toBeGreaterThan(initialCount);

  const sizes = await game1.getAsteroidSizes();
  const fragments = sizes.filter((r) => r >= 25 && r < large.radius);
  expect(fragments.length, 'expected medium fragments after the collab split').toBeGreaterThan(0);
}, TestConfig.DEFAULT_TIMEOUT * 2);
