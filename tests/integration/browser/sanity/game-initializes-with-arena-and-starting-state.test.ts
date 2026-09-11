import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'game initializes with arena and starting player state',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });

    await game.verifyGameCanvas();
    await game.verifyGameArea();
    await game.waitForAsteroids(1);

    expect(await game.getLives()).toBe(3);
    expect(await game.getScore()).toBe(0);
    const [health, maxHealth] = await Promise.all([game.getShipHealth(), game.getShipMaxHealth()]);
    expect(health).toBe(maxHealth);
    expect(await game.getAsteroidCount()).toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.gameController?.getNetworkManager().getAllPlayers() ?? [])
            .filter((player) => player.type === 'bot')
            .map((player) => player.factionId ?? player.ship.factionId)
            .sort()
        )
      )
      .toEqual(['ember', 'ion']);
  },
  TestConfig.DEFAULT_TIMEOUT
);
