import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();
test(
  'a pilot keeps playing after four deaths without returning to the menu',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page missing');
    }
    const game = new GameInteractions(page);
    await game.bootGame();
    for (let death = 0; death < 4; death++) {
      await game.dieOnceViaBoundary();
      await game.waitForShipAlive();
      expect(await game.isGameRunning()).toBe(true);
      expect(await game.isStartScreenVisible()).toBe(false);
      expect(await game.getShipHealth()).toBeGreaterThan(0);
    }
  },
  TestConfig.DEFAULT_TIMEOUT * 3
);
