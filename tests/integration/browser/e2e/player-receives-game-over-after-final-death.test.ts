import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'player receives game over after final death',
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
      .poll(() => game.isGameRunning(), {
        timeout: 12000,
        message: 'game loop should stop after final death',
      })
      .toBe(false);

    await expect
      .poll(() => game.isStartScreenVisible(), {
        timeout: 12000,
        message: 'start screen should return after game over',
      })
      .toBe(true);

    const hudText = await game.getHudText();
    expect(hudText.toLowerCase()).toContain('game over');
  },
  TestConfig.DEFAULT_TIMEOUT * 3
);
