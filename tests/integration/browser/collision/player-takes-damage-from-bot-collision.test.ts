import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'player takes damage from bot collision',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForCombatReady();
    await game.waitForBots(1);

    const hostileBotId = await game.getHostileBotId();
    const startHealth = await game.getShipHealth();
    const livesBefore = await game.getLives();

    for (let attempt = 0; attempt < 10 && (await game.getShipHealth()) === startHealth; attempt++) {
      expect(await game.getLives(), 'collision setup must stop before costing a life').toBe(
        livesBefore
      );
      await game.pinShipOnBot(hostileBotId, 150);
    }

    expect(
      await game.getShipHealth(),
      'ramming a hostile bot should deal collision damage'
    ).toBeLessThan(startHealth);
    expect(await game.getLives(), 'the observed collision damage should be nonlethal').toBe(
      livesBefore
    );
  },
  TestConfig.DEFAULT_TIMEOUT
);
