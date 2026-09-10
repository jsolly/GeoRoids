import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'a hostile bot explodes and respawns after lethal laser damage',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    // Warden's real E absorb keeps the local hull alive while the hostile bot
    // is approached and its server-authoritative laser shield cycles.
    await game.bootGame({ kitId: 'warden' });
    await game.waitForBots(1);

    await page.keyboard.press('e');
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
            return ship?.shieldTimer ?? 0;
          }),
        { timeout: 5000, message: 'Warden E should activate the real absorb shield' }
      )
      .toBeGreaterThan(0);

    const hostileBotId = await game.getHostileBotId();
    const bot = (await game.getBots()).find((candidate) => candidate.id === hostileBotId);
    expect(bot, 'an alive hostile bot should be available for laser damage').toBeDefined();
    if (!bot) {
      return;
    }
    const deathPosition = { x: bot.x, y: bot.y };

    // A live laser volley must produce the bot's actual explosion signal; a
    // forged botDamage payload is rejected by the server and cannot stand in
    // for this scenario.
    const result = await game.attackBotWithLasers(bot.id, 12);
    expect(
      result.everExploding || result.minHealthObserved <= 0,
      'the selected hostile bot should be destroyed by live laser fire'
    ).toBe(true);
    expect(
      result.scoreGain,
      'the selected bot death should be credited to the player laser'
    ).toBeGreaterThanOrEqual(50);

    const respawnPosition = await game.waitForBotRespawn(bot.id);
    expect(respawnPosition.x !== deathPosition.x || respawnPosition.y !== deathPosition.y).toBe(
      true
    );
  },
  TestConfig.DEFAULT_TIMEOUT
);
