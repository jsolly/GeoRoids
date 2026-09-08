import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'one player laser deals canonical nonlethal damage to a remote player',
  async () => {
    const page1 = browserManager.getCurrentPage();
    if (!page1) {
      throw new Error('Page 1 not available');
    }

    const page2 = await browserManager.createAdditionalPage();

    const game1 = new GameInteractions(page1);
    const game2 = new GameInteractions(page2);

    await page1.bringToFront();
    await game1.bootGame({ waitForCombatReady: false });
    await game1.placeShipAt(-1800, 0);
    await page2.bringToFront();
    await game2.bootGame({ waitForCombatReady: false });
    await game2.placeShipAt(-1700, 0);
    await Promise.all([game1.waitForCombatReady(), game2.waitForCombatReady()]);
    await game1.waitForRemoteHumanPlayers(1);
    await game2.placeShipAt(-1700, 0);

    const targetId = await game2.getLocalPlayerId();
    expect(await game1.getRemoteHumanPlayerIds()).toContain(targetId);
    const healthBefore = await game2.getShipHealth();
    const livesBefore = await game2.getLives();

    await game1.fireLaserAtRemotePlayer(targetId);
    await game1.placeShipAt(1700, 0);
    await game2.waitForShipHealth(healthBefore - 25, 20000);
    expect(await game2.getShipHealth()).toBe(healthBefore - 25);
    expect(await game2.getLives()).toBe(livesBefore);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
