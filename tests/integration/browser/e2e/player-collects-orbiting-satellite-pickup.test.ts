import { expect, test } from 'vitest';
import { SATELLITE_PICKUP } from '../../../../src/constants';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('a player collects a shared satellite and it orbits with a score bonus', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Page not available');
  }

  const game = new GameInteractions(page);
  await game.bootSinglePlayerGame();
  await game.waitForSatellitePickups(2);

  const pickups = await game.getSatellitePickups();
  expect(pickups.length).toBeGreaterThanOrEqual(2);
  expect(pickups.every((pickup) => pickup.state === 'loose')).toBe(true);

  const target = pickups[0]!;
  const scoreBefore = await game.getScore();

  await expect
    .poll(
      async () => {
        await game.pinShipOnSatellitePickup(target.id, 200);
        const later = await game.getSatellitePickups();
        return later.find((pickup) => pickup.id === target.id)?.state ?? '';
      },
      {
        timeout: 10000,
        message: 'the collected satellite should orbit the player',
      }
    )
    .toBe('orbiting');

  await expect
    .poll(async () => game.getScore(), {
      timeout: 8000,
      message: 'collecting a satellite pickup should award points',
    })
    .toBeGreaterThanOrEqual(scoreBefore + SATELLITE_PICKUP.SCORE_BONUS);
}, TestConfig.DEFAULT_TIMEOUT);
