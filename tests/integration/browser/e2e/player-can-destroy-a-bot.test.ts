import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'a player destroys a bot and sees the kill banner, score, and leaderboard update',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);

    await game.bootGame();

    await game.waitForBots(1);
    const bots = await game.getBots();
    expect(bots.length).toBeGreaterThan(0);
    const hostileBotId = await game.getHostileBotId();
    const target = bots.find((bot) => bot.id === hostileBotId);
    expect(target, 'an alive hostile bot should be available for laser damage').toBeDefined();
    if (!target) {
      return;
    }
    const initialHealth = target.health;
    const names = await page.evaluate((targetId) => {
      const players = window.gameController?.getNetworkManager?.().getAllPlayers?.() ?? [];
      return {
        local: window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.name ?? '',
        target: players.find((player) => player.id === targetId)?.name ?? '',
      };
    }, target.id);
    expect(names.target, 'the hostile bot should have a visible name').toBeTruthy();
    expect(names.local, 'the local player should have a visible name').toBeTruthy();
    if (!names.target || !names.local) {
      throw new Error('The combatants did not expose visible names');
    }
    const scoreBefore = await game.getScore();

    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __combatHudDraws?: Array<{ text: string; x: number; y: number }>;
      };
      testWindow.__combatHudDraws = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (
        text: string,
        x: number,
        y: number,
        maxWidth?: number
      ): void {
        const canvas = this.canvas;
        if (x > canvas.getBoundingClientRect().width / 2 || text.startsWith('You killed ')) {
          testWindow.__combatHudDraws?.push({ text, x, y });
          if ((testWindow.__combatHudDraws?.length ?? 0) > 1000) {
            testWindow.__combatHudDraws?.splice(0, 500);
          }
        }
        original.call(this, text, x, y, maxWidth);
      };
    });

    const result = await game.attackBotWithLasers(target.id, 12);

    expect(result.minHealthObserved, 'bot should take laser damage').toBeLessThan(initialHealth);
    expect(result.everExploding || result.minHealthObserved <= 0).toBe(true);
    expect(result.scoreGain).toBeGreaterThanOrEqual(50);
    await expect
      .poll(
        () =>
          page.evaluate(
            (targetName) =>
              (
                window as typeof window & {
                  __combatHudDraws?: Array<{ text: string; x: number; y: number }>;
                }
              ).__combatHudDraws?.some((draw) => draw.text === `You killed ${targetName}`) ?? false,
            names.target
          ),
        { timeout: 5000, message: 'the credited bot kill should be drawn in the HUD' }
      )
      .toBe(true);
    await expect
      .poll(() => game.getScore(), {
        timeout: 8000,
        message: 'destroying a bot should award points',
      })
      .toBeGreaterThanOrEqual(scoreBefore + 50);

    const scoreAfter = await game.getScore();
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ localName, score }) => {
              const draws =
                (
                  window as typeof window & {
                    __combatHudDraws?: Array<{ text: string; x: number; y: number }>;
                  }
                ).__combatHudDraws ?? [];
              return draws.some(
                (draw, index) =>
                  draw.text === localName &&
                  draws
                    .slice(index + 1, index + 3)
                    .some((next) => next.text === String(score) && next.y === draw.y)
              );
            },
            { localName: names.local, score: scoreAfter }
          ),
        { timeout: 5000, message: 'the awarded score should be drawn in the leaderboard' }
      )
      .toBe(true);
  },
  TestConfig.DEFAULT_TIMEOUT
);
