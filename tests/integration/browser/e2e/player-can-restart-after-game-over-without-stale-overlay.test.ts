import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'player can restart after game over without a stale overlay',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForCombatReady();

    await game.dieUntilGameOver();

    await expect
      .poll(async () => (await game.getHudText()).toLowerCase(), {
        timeout: 5000,
        message: 'game over overlay should appear after the final life',
      })
      .toContain('game over');

    expect((await game.getHudText()).toLowerCase()).not.toContain('unknown');
    expect(await game.getShipHealth()).toBe(0);

    await expect
      .poll(() => game.isStartScreenVisible(), {
        timeout: 8000,
        message: 'start screen should return about 3.5s after game over',
      })
      .toBe(true);

    await game.startGame();
    await game.waitForGameReady();
    await game.waitForServerJoin();

    const hudAfterRestart = (await game.getHudText()).toLowerCase();
    expect(hudAfterRestart).not.toContain('game over');
    expect(hudAfterRestart).not.toContain('unknown');
    expect(await game.getLives()).toBe(3);
    expect(await game.isGameRunning()).toBe(true);

    await page.waitForTimeout(5000);

    expect(await game.isGameRunning()).toBe(true);
    expect((await game.getHudText()).toLowerCase()).not.toContain('game over');
    expect((await game.getHudText()).toLowerCase()).not.toContain('unknown');
  },
  TestConfig.DEFAULT_TIMEOUT * 3
);
