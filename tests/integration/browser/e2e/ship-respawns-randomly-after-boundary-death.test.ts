import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { expectRandomRespawnPlacement } from '../../utils/respawn-assertions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'ship respawns at a random location after boundary death',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForCombatReady();

    const initialLives = await game.getLives();
    const deathPosition = await game.dieOnceViaBoundary();

    expect(await game.getLives()).toBeLessThan(initialLives);
    const respawnPosition = await game.getShipPosition();
    expectRandomRespawnPlacement(deathPosition, respawnPosition);
    expect(await game.getShipDistanceFromCenter()).toBeLessThan(3100);
    expect(await game.getShipHealth()).toBeGreaterThan(0);
  },
  TestConfig.DEFAULT_TIMEOUT * 3
);
