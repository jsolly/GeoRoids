import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { expectFurnaceRespawnPlacement } from '../../utils/respawn-assertions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'ship respawns near the nearest furnace after asteroid collision death',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForCombatReady();

    // The helper requires the authoritative asteroid death event, which remains
    // observable even if the short respawn finishes before the next test step.
    const deathPosition = await game.dieFromAsteroidImpact();
    const respawnPosition = await game.waitForRandomRespawnPlacement(deathPosition);
    expectFurnaceRespawnPlacement(deathPosition, respawnPosition);
    const [health, maxHealth] = await Promise.all([game.getShipHealth(), game.getShipMaxHealth()]);
    expect(health).toBe(maxHealth);
    expect(await game.isShipExploding()).toBe(false);
  },
  TestConfig.DEFAULT_TIMEOUT * 3
);
