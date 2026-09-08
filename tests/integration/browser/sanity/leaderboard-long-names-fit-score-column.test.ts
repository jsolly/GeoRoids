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
  y: number;
  width: number;
  textAlign: CanvasTextAlign;
  fillStyle: string;
  font: string;
};

async function captureLeaderboardRow(page: import('playwright').Page): Promise<RenderedText[]> {
  return page.evaluate(
    ({ longName, wideScore }) => {
      const win = window as typeof window & {
        __leaderboardFillTextCalls?: RenderedText[];
      };
      win.__leaderboardFillTextCalls = [];

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
            y,
            width: this.measureText(text).width,
            textAlign: this.textAlign,
            fillStyle: String(this.fillStyle),
            font: this.font,
          });
        }
        originalFillText.call(this, text, x, y, maxWidth);
      };

      try {
        const gameController = window.gameController;
        if (!gameController) {
          throw new Error('Leaderboard fixture requires a game controller');
        }
        const local = gameController.getCurrPlayer();
        const players = gameController.getNetworkManager().getAllPlayers();
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
      } finally {
        CanvasRenderingContext2D.prototype.fillText = originalFillText;
      }
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
      const canvas = document.getElementById('gameCanvas');
      return (
        canvas instanceof HTMLCanvasElement &&
        canvas.width === expectedWidth &&
        canvas.height === expectedHeight
      );
    },
    { expectedWidth: width, expectedHeight: height },
    { timeout: 5000 }
  );
  const calls = await captureLeaderboardRow(page);
  const name = calls.find((call) => call.text.includes('…') && call.x > width / 2);
  const score = calls.find((call) => call.text === String(WIDE_SCORE) && call.x > width / 2);
  const touch = width <= 500 || height <= 430;
  const boardWidth = touch ? (width < 400 ? 148 : 168) : 180;
  const boardEdge = touch ? 12 : 16;
  const boardX = width - boardWidth - boardEdge;
  expect(name, `ellipsis name should render at ${width}x${height}`).toBeDefined();
  expect(score, `wide score should render at ${width}x${height}`).toBeDefined();
  expect(name?.x).toBe(boardX + 28);
  expect(score?.x).toBe(boardX + boardWidth - 4);
  expect(name?.y).toBe(score?.y);
  expect(name?.textAlign).toBe('left');
  expect(score?.textAlign).toBe('right');
  expect(name?.font).toBe('11px Arial');
  expect(name?.fillStyle).toContain('94, 234, 212');
  expect(score?.fillStyle).toContain('100, 116, 139');
  expect(name?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    (score?.x ?? 0) - (name?.x ?? 0) - (score?.width ?? 0) - 6
  );

  await page.screenshot({ path: screenshotPath });
  expect(existsSync(screenshotPath)).toBe(true);
}

test(
  'long leaderboard names stay aligned with scores across desktop, portrait, and landscape play views',
  async () => {
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
      1280,
      900,
      screenshotManager.getScreenshotPath('leaderboard-long-name-desktop.png')
    );
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
