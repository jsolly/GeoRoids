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
    return { playerNames, drawnText, hasFactionFields };
  });
}

test.each([1280, 390])(
  'one shared crew keeps every active pilot on the scoreboard at %i pixels',
  async (width) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page unavailable');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });

    const capture = await captureScoreboard(page);
    expect(capture.hasFactionFields).toBe(false);
    expect(capture.playerNames).toContain('Crew pilot');
    expect(capture.drawnText).toContain('Crew pilot');

    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`crew-scoreboard-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
