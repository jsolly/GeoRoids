import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

type ScoreboardCapture = {
  playerNames: string[];
  botNames: string[];
  drawnText: string[];
  hasFactionFields: boolean;
};

async function captureScoreboard(page: import('playwright').Page): Promise<ScoreboardCapture> {
  return page.evaluate(() => {
    const controller = window.gameController;
    const canvas = document.getElementById('gameCanvas');
    if (!controller || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error('Crew scoreboard fixture requires the game controller and canvas');
    }
    const local = controller.getCurrPlayer();
    if (!local) {
      throw new Error('Crew scoreboard fixture requires a local pilot');
    }
    local.name = 'Crew pilot';
    const players = controller.getNetworkManager().getAllPlayers();
    const playerNames = players.map((player) => player.name);
    const botNames = players
      .filter((player) => player.type === 'bot')
      .map((player) => `${player.name} (bot)`);
    const hasFactionFields = players.some(
      (player) => 'factionId' in player || 'factionId' in player.ship
    );
    const drawnText: string[] = [];
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text: string,
      x: number,
      y: number,
      maxWidth?: number
    ): void {
      if (this.canvas === canvas) {
        drawnText.push(text);
      }
      originalFillText.call(this, text, x, y, maxWidth);
    };
    const state = controller.getGameStateManager();
    const wasRunning = state.getIsGameRunning();
    state.setIsGameRunning(false);
    try {
      controller.renderGame();
    } finally {
      CanvasRenderingContext2D.prototype.fillText = originalFillText;
      state.setIsGameRunning(wasRunning);
    }
    return { playerNames, botNames, drawnText, hasFactionFields };
  });
}

test.each([1280, 390])(
  'one shared crew keeps every active pilot and bot on the scoreboard at %i pixels',
  async (width) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page unavailable');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await game.waitForBots(1);

    const capture = await captureScoreboard(page);
    expect(capture.botNames.length).toBeGreaterThan(0);
    expect(capture.hasFactionFields).toBe(false);
    expect(capture.playerNames.length).toBeGreaterThanOrEqual(capture.botNames.length + 1);
    for (const botName of capture.botNames) {
      expect(capture.drawnText, `${botName} should be rendered in the leaderboard`).toContain(
        botName
      );
    }
    expect(capture.drawnText).toContain('Crew pilot');

    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`crew-scoreboard-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
