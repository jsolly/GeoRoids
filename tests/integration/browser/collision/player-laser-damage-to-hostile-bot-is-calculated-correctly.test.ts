import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'a player laser deals canonical damage to a hostile bot',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    const botUpdates: Array<{
      botId?: string;
      health?: number;
      timestamp?: number;
    }> = [];
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        try {
          const message = JSON.parse(String(payload));
          if (message.type === 'botUpdate' && message.data) {
            botUpdates.push({
              botId: message.data.botId,
              health: message.data.health,
              timestamp: message.timestamp,
            });
          }
        } catch {
          // Non-JSON frames are outside this scenario's bot update stream.
        }
      });
    });
    await game.bootGame();
    await game.waitForBots(1);

    const hostileBotId = await game.getHostileBotId();
    const bot = (await game.getBots()).find((candidate) => candidate.id === hostileBotId);
    expect(bot, 'an alive hostile bot should be available for laser damage').toBeDefined();
    if (!bot) {
      return;
    }
    const initialHealth = bot.health;
    const localPlayerId = await page.evaluate(() => {
      const gc = window.gameController;
      return gc?.getNetworkManager?.().getLocalPlayerId?.();
    });
    expect(localPlayerId, 'the local player must be joined before firing').toBeTruthy();
    const updateCountBeforeShot = botUpdates.length;

    // This helper creates a real local laser, waits for the authoritative pose
    // acknowledgement, and reports the observed hit. The server's existing
    // botUpdate broadcast is the accepted-hit evidence; it carries the raw
    // post-damage health before the browser's prediction can regenerate it.
    const result = await game.attackBotWithLasers(bot.id, 1);

    await expect
      .poll(
        () =>
          botUpdates
            .slice(updateCountBeforeShot)
            .find(
              (update) =>
                update.botId === bot.id &&
                update.health !== undefined &&
                update.health < initialHealth
            ),
        { timeout: 5000, message: 'server should broadcast the accepted hostile bot laser hit' }
      )
      .toBeDefined();
    const damageUpdate = botUpdates
      .slice(updateCountBeforeShot)
      .find(
        (update) =>
          update.botId === bot.id && update.health !== undefined && update.health < initialHealth
      );
    expect(damageUpdate?.health, 'server should report the bot health after this hit').toBeCloseTo(
      initialHealth - 25,
      0
    );
    expect(
      result.minHealthObserved,
      'the live bot view should show the health reduction'
    ).toBeLessThan(initialHealth);
  },
  TestConfig.DEFAULT_TIMEOUT
);
