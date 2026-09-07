import { expect, test } from 'vitest';
import { SATELLITE } from '../../../../src/constants';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('a player destroys a satellite with lasers and is awarded the kill', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Page not available');
  }

  const game = new GameInteractions(page);
  await game.bootGame();
  await game.waitForSatellites(1);

  const satellites = await game.getSatellites();
  expect(satellites.length).toBeGreaterThan(0);
  const target = satellites[0]!;
  const scoreBefore = await game.getScore();

  const result = await game.attackSatelliteWithLasers(target.id, 10);

  expect(result.minHealthObserved, 'satellite should take laser damage').toBeLessThan(SATELLITE.HEALTH);

  await expect
    .poll(() => game.getScore(), {
      timeout: 8000,
      message: 'destroying a satellite should award points',
    })
    .toBeGreaterThanOrEqual(scoreBefore + SATELLITE.POINTS);
}, TestConfig.DEFAULT_TIMEOUT);
