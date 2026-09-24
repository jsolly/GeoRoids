import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { expectFurnaceRespawnPlacement } from '../../utils/respawn-assertions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'ship respawns near the nearest furnace after boundary death',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForCombatReady();

    const deathPosition = await game.dieOnceViaBoundary();

    expect(await game.getShipHealth()).toBe(await game.getShipMaxHealth());
    const respawnPosition = await game.getShipPosition();
    expectFurnaceRespawnPlacement(deathPosition, respawnPosition);
    expect(await game.getShipHealth()).toBeGreaterThan(0);
  },
  TestConfig.DEFAULT_TIMEOUT * 3
);
