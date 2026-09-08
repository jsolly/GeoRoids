import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';

import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

const LONG_NAME = 'QA7skirmisherportrait';
const WIDE_SCORE = 987654321;

type RenderedText = {
  text: string;
  x: number;
  width: number;
};

async function captureLeaderboardRow(page: import('playwright').Page): Promise<RenderedText[]> {
  return page.evaluate(
    ({ longName, wideScore }) => {
      const win = window as typeof window & {
        __leaderboardFillTextCalls?: RenderedText[];
        __leaderboardFillTextInstalled?: boolean;
      };
      win.__leaderboardFillTextCalls = [];

      if (!win.__leaderboardFillTextInstalled) {
        const originalFillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (
          text: string,
          x: number,
          y: number,
          maxWidth?: number
        ): void {
          if (typeof text === 'string' && (text.includes('…') || text === String(wideScore))) {
            win.__leaderboardFillTextCalls?.push({
              text,
              x,
              width: this.measureText(text).width,
            });
          }
          originalFillText.call(this, text, x, y, maxWidth);
        };
        win.__leaderboardFillTextInstalled = true;
      }

      const gameController = (window as { gameController?: any }).gameController;
      const local = gameController?.playerManager?.getLocalPlayer?.();
      const players = gameController?.getNetworkManager?.().getAllPlayers?.() ?? [];
      if (!local || players.length < 2) {
        throw new Error('Leaderboard fixture requires a local player and at least one bot');
      }

      local.name = longName;
      local.score = wideScore;
      for (const player of players) {
        if (player.id === local.id) {
          player.name = longName;
          player.score = wideScore;
        }
      }
      gameController.renderGame();
      return win.__leaderboardFillTextCalls ?? [];
    },
    { longName: LONG_NAME, wideScore: WIDE_SCORE }
  );
}

async function verifyViewport(
  page: import('playwright').Page,
  width: number,
  height: number,
  screenshotPath: string
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    ({ expectedWidth, expectedHeight }) => {
      const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;
      return canvas?.width === expectedWidth && canvas.height === expectedHeight;
    },
    { expectedWidth: width, expectedHeight: height },
    { timeout: 5000 }
  );
  const calls = await captureLeaderboardRow(page);
  const name = calls.find((call) => call.text.includes('…') && call.x > width / 2);
  const score = calls.find((call) => call.text === String(WIDE_SCORE) && call.x > width / 2);
  expect(name, `ellipsis name should render at ${width}x${height}`).toBeDefined();
  expect(score, `wide score should render at ${width}x${height}`).toBeDefined();
  expect(name?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    (score?.x ?? 0) - (name?.x ?? 0) - (score?.width ?? 0) - 6
  );

  await page.screenshot({ path: screenshotPath });
  expect(existsSync(screenshotPath)).toBe(true);
}

test(
  'long leaderboard names stay separated from scores on portrait and landscape play views',
  async () => {
    await browserManager.recreatePage({ hasTouch: true });
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await game.waitForBots(1);

    await verifyViewport(
      page,
      390,
      844,
      screenshotManager.getScreenshotPath('leaderboard-long-name-mobile.png')
    );
    await verifyViewport(
      page,
      844,
      390,
      screenshotManager.getScreenshotPath('leaderboard-long-name-landscape.png')
    );

    expect(consoleErrors).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
