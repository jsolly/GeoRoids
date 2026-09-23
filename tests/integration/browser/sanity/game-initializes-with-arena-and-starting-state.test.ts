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
    await game.waitForAsteroids(20);

    expect(await game.getLives()).toBe(5);
    expect(await game.getScore()).toBe(0);
    const [health, maxHealth] = await Promise.all([game.getShipHealth(), game.getShipMaxHealth()]);
    expect(health).toBe(maxHealth);
    expect(await game.getAsteroidCount()).toBeGreaterThanOrEqual(20);
    const pilots = await page.evaluate(() =>
      (window.gameController?.getNetworkManager().getAllPlayers() ?? []).map((player) => ({
        id: player.id,
        name: player.name,
        type: player.type,
        kitId: player.ship.kitId,
        hasLegacyTeamField: 'factionId' in player || 'factionId' in player.ship,
      }))
    );
    expect(pilots.every((pilot) => pilot.id.length > 0 && pilot.name.length > 0)).toBe(true);
    expect(pilots.every((pilot) => pilot.kitId === 'scout' || pilot.kitId === 'hauler')).toBe(true);
    expect(pilots.every((pilot) => pilot.hasLegacyTeamField === false)).toBe(true);
    expect(pilots.every((pilot) => pilot.type === 'local' || pilot.type === 'remote')).toBe(true);
  },
  TestConfig.DEFAULT_TIMEOUT
);
