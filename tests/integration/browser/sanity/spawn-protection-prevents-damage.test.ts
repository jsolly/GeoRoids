import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'spawn protection prevents damage',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const attacker = new GameInteractions(await browserManager.createPage());
    await attacker.bootGame({ waitForCombatReady: false });
    await attacker.placeShipAt(-1800, 0);
    await attacker.waitForCombatReady();
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await game.placeShipAt(-1700, 0);
    await attacker.waitForRemoteHumanPlayers(1);
    const targetId = await game.getLocalPlayerId();
    await game.waitForServerSpawnProtection();

    expect(await game.isServerSpawnProtected()).toBe(true);
    const healthWhileProtected = await game.getShipHealth();
    await attacker.fireLaserAtRemotePlayer(targetId);
    await page.waitForTimeout(400);
    expect(await game.getShipHealth()).toBe(healthWhileProtected);

    await game.waitForCombatReady();
    expect(await game.isServerSpawnProtected()).toBe(false);

    const healthBeforeDamage = await game.getShipHealth();
    await attacker.fireLaserAtRemotePlayer(targetId);
    await expect
      .poll(() => game.getShipHealth(), {
        timeout: 5000,
        message: 'damage should apply after protection ends',
      })
      .toBe(healthBeforeDamage - 25);
  },
  TestConfig.DEFAULT_TIMEOUT
);
