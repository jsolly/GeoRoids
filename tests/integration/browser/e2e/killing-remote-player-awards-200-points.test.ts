import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'killing remote player awards 200 points',
  async () => {
    const page1 = browserManager.getCurrentPage();
    if (!page1) {
      throw new Error('Page 1 not available');
    }

    await browserManager.createPage();
    const page2 = browserManager.getCurrentPage();
    if (!page2) {
      throw new Error('Page 2 not available');
    }

    const game1 = new GameInteractions(page1);
    const game2 = new GameInteractions(page2);

    await game1.bootGame({ waitForCombatReady: false });
    await game1.placeShipAt(-1800, -1800);
    await game2.bootGame({ waitForCombatReady: false });
    await game2.placeShipAt(1800, 1800);
    await game1.waitForRemoteHumanPlayers(1);
    await game2.waitForRemoteHumanPlayers(1);
    await game1.waitForCombatReady();
    await game2.waitForCombatReady();

    const targetId = await game2.getLocalPlayerId();
    expect(await game1.getRemoteHumanPlayerIds()).toContain(targetId);
    const scoreBefore = await game1.getScore();
    const shooterLivesBefore = await game1.getLives();
    const victimLivesBefore = await game2.getLives();

    for (let shot = 0; shot < 8 && (await game2.getLives()) === victimLivesBefore; shot++) {
      expect(await game1.getLives(), 'the shooter must stay alive to receive kill credit').toBe(
        shooterLivesBefore
      );
      await game2.placeShipAt(1800, 1800);
      const target = await game2.getShipPosition();
      await game1.placeShipAt(target.x - 120, target.y);
      await game1.fireLaserToward(target.x, target.y);
      await game1.placeShipAt(-1800, -1800);
      await page2.waitForTimeout(350);
    }

    await expect
      .poll(() => game2.getLives(), {
        timeout: 5000,
        message: 'the targeted remote player should lose one life to the shooter',
      })
      .toBeLessThan(victimLivesBefore);
    expect(await game1.getLives(), 'the credited shooter should still be alive').toBe(
      shooterLivesBefore
    );
    await expect
      .poll(() => game1.getScore(), { timeout: 10000, message: 'PvP kill should award 200 points' })
      .toBeGreaterThanOrEqual(scoreBefore + 200);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
