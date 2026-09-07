import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('ramming a satellite damages the player ship', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Page not available');
  }

  const game = new GameInteractions(page);
  await game.bootGame();
  await game.waitForCombatReady();
  await game.waitForSatellites(1);

  const satellite = (await game.getSatellites())[0]!;
  const startHealth = await game.getShipHealth();

  await game.pinShipOnSatellite(satellite.id, 3000);

  await expect
    .poll(() => game.getShipHealth(), {
      timeout: 8000,
      message: 'ramming a satellite should deal collision damage',
    })
    .toBeLessThan(startHealth);
}, TestConfig.DEFAULT_TIMEOUT);
