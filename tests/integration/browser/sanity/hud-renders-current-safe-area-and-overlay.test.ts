import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';

import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

type SafeArea = { top: number; right: number; bottom: number; left: number };

type DrawnText = {
  text: string;
  x: number;
  y: number;
  font: string;
  fillStyle: string;
  textAlign: CanvasTextAlign;
};

type DrawnArc = { x: number; y: number; radius: number };
type HudFrame = {
  canvas: { width: number; height: number };
  texts: DrawnText[];
  arcs: DrawnArc[];
};

type CaptureOptions = { safeArea: SafeArea; score: number; overlay?: string };

async function setViewport(
  page: import('playwright').Page,
  width: number,
  height: number
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
}

async function captureHudFrame(
  page: import('playwright').Page,
  options: CaptureOptions
): Promise<HudFrame> {
  return page.evaluate((capture) => {
    const canvasElement = document.getElementById('gameCanvas');
    const probeElement = document.getElementById('safe-area-probe');
    if (!(canvasElement instanceof HTMLCanvasElement) || !(probeElement instanceof HTMLElement)) {
      throw new Error('HUD fixture requires the game canvas and safe-area probe');
    }

    const original = {
      arc: CanvasRenderingContext2D.prototype.arc,
      fillText: CanvasRenderingContext2D.prototype.fillText,
    };
    const texts: DrawnText[] = [];
    const arcs: DrawnArc[] = [];

    CanvasRenderingContext2D.prototype.arc = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      radius: number,
      startAngle: number,
      endAngle: number,
      counterclockwise?: boolean
    ): void {
      if (this.canvas === canvasElement && radius >= 20 && radius <= 60) {
        arcs.push({ x, y, radius });
      }
      original.arc.call(this, x, y, radius, startAngle, endAngle, counterclockwise);
    };
    CanvasRenderingContext2D.prototype.fillText = function (
      this: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      maxWidth?: number
    ): void {
      if (this.canvas === canvasElement) {
        texts.push({
          text,
          x,
          y,
          font: this.font,
          fillStyle: String(this.fillStyle),
          textAlign: this.textAlign,
        });
      }
      original.fillText.call(this, text, x, y, maxWidth);
    };
    const previousProbeStyle = probeElement.getAttribute('style');
    try {
      probeElement.style.paddingTop = `${capture.safeArea.top}px`;
      probeElement.style.paddingRight = `${capture.safeArea.right}px`;
      probeElement.style.paddingBottom = `${capture.safeArea.bottom}px`;
      probeElement.style.paddingLeft = `${capture.safeArea.left}px`;

      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('HUD fixture requires a game controller');
      }
      const local = gameController.getCurrPlayer();
      const players = gameController.getNetworkManager().getAllPlayers();
      if (!local || players.length < 2) {
        throw new Error('HUD fixture requires a local player and at least one bot');
      }

      local.name = 'HUD pilot';
      local.score = capture.score;
      local.lives = 3;
      local.factionId = 'ion';
      local.ship.factionId = 'ion';
      local.ship.kitId = 'dart';
      local.ship.fuel = local.ship.maxFuel / 2;
      for (const player of players) {
        if (player.id === local.id) {
          player.name = local.name;
          player.score = local.score;
          player.factionId = local.factionId;
          player.ship.factionId = local.ship.factionId;
        }
      }

      if (capture.overlay) {
        gameController.getGameStateManager().updateTextProperties(capture.overlay, 1);
      } else {
        gameController.getGameStateManager().clearOverlay();
      }
      gameController.renderGame();
      return {
        canvas: { width: canvasElement.width, height: canvasElement.height },
        texts,
        arcs,
      };
    } finally {
      CanvasRenderingContext2D.prototype.arc = original.arc;
      CanvasRenderingContext2D.prototype.fillText = original.fillText;
      if (previousProbeStyle === null) {
        probeElement.removeAttribute('style');
      } else {
        probeElement.setAttribute('style', previousProbeStyle);
      }
    }
  }, options);
}

function textDrawn(frame: HudFrame, text: string, leftHalf = false): DrawnText | undefined {
  return frame.texts.find(
    (draw) => draw.text === text && (!leftHalf || draw.x < frame.canvas.width / 2)
  );
}

function arcDrawn(frame: HudFrame, radius: number, x: number, y: number): DrawnArc | undefined {
  return frame.arcs.find((arc) => arc.radius === radius && arc.x === x && arc.y === y);
}

function styleHas(style: string, hex: string, channels: string): boolean {
  const normalized = style.toLowerCase();
  return normalized.includes(hex.toLowerCase()) || normalized.includes(channels);
}

function saveScreenshot(page: import('playwright').Page, path: string): Promise<void> {
  return page.screenshot({ path }).then(() => {
    expect(existsSync(path)).toBe(true);
  });
}

test(
  'rendered HUD follows safe-area changes and keeps compact game-over composition visible',
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

    let wasRunning: boolean | undefined;
    try {
      const game = new GameInteractions(page);
      await game.bootGame({ waitForCombatReady: false });
      await game.waitForBots(1);
      wasRunning = await page.evaluate(() => {
        const gameController = window.gameController;
        if (!gameController) {
          throw new Error('HUD fixture requires a game controller');
        }
        const state = gameController.getGameStateManager();
        const running = state.getIsGameRunning();
        state.setIsGameRunning(false);
        return running;
      });

      await setViewport(page, 1280, 900);
      const desktop = await captureHudFrame(page, {
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        score: 2468,
      });
      expect(desktop.canvas).toEqual({ width: 1280, height: 900 });
      expect(textDrawn(desktop, '2468', true)?.x).toBe(80);
      expect(arcDrawn(desktop, 48, 1216, 836)).toBeDefined();
      await saveScreenshot(
        page,
        screenshotManager.getScreenshotPath('hud-composition-desktop.png')
      );

      await setViewport(page, 390, 844);
      const portrait = await captureHudFrame(page, {
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        score: 2468,
      });
      const shiftedPortrait = await captureHudFrame(page, {
        safeArea: { top: 47, right: 24, bottom: 34, left: 24 },
        score: 2468,
        overlay: 'Game Over: radar collision',
      });
      expect(portrait.canvas).toEqual({ width: 390, height: 844 });
      expect(shiftedPortrait.canvas).toEqual(portrait.canvas);

      const portraitScore = textDrawn(portrait, '2468', true);
      const shiftedScore = textDrawn(shiftedPortrait, '2468', true);
      const portraitFaction = textDrawn(portrait, 'ION');
      const shiftedFaction = textDrawn(shiftedPortrait, 'ION');
      expect(portraitScore).toBeDefined();
      expect(shiftedScore).toBeDefined();
      expect(portraitFaction).toBeDefined();
      expect(shiftedFaction).toBeDefined();
      expect(shiftedScore?.x).toBe((portraitScore?.x ?? 0) + 20);
      expect(shiftedScore?.y).toBe((portraitScore?.y ?? 0) + 43);
      expect(shiftedFaction?.x).toBe((portraitFaction?.x ?? 0) + 20);
      expect(shiftedFaction?.y).toBe((portraitFaction?.y ?? 0) + 43);
      expect(styleHas(portraitScore?.fillStyle ?? '', '#e2e8f0', '226, 232, 240')).toBe(true);
      expect(portraitFaction?.fillStyle).toContain('168, 160, 200');

      const portraitRing = arcDrawn(portrait, 40, 338, 680);
      const shiftedRing = arcDrawn(shiftedPortrait, 40, 318, 650);
      expect(portraitRing).toBeDefined();
      expect(shiftedRing).toBeDefined();
      expect(shiftedRing?.x).toBe((portraitRing?.x ?? 0) - 20);
      expect(shiftedRing?.y).toBe((portraitRing?.y ?? 0) - 30);

      const gameOver = textDrawn(shiftedPortrait, 'GAME OVER');
      expect(gameOver).toBeDefined();
      expect(gameOver?.x).toBe(195);
      expect(gameOver?.y).toBeCloseTo(422 - 80 * 0.72, 5);
      expect(gameOver?.font).toBe('bold 35px Arial');
      expect(gameOver?.textAlign).toBe('center');
      expect(styleHas(gameOver?.fillStyle ?? '', '#f43f5e', '244, 63, 94')).toBe(true);
      expect(shiftedPortrait.texts.some((draw) => draw.text.toLowerCase().includes('server'))).toBe(
        false
      );
      await saveScreenshot(
        page,
        screenshotManager.getScreenshotPath('hud-composition-portrait-game-over.png')
      );

      await setViewport(page, 844, 390);
      const landscape = await captureHudFrame(page, {
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        score: 2468,
      });
      expect(landscape.canvas).toEqual({ width: 844, height: 390 });
      const radar = arcDrawn(landscape, 32, 44, 117);
      expect(radar).toBeDefined();
      expect(textDrawn(landscape, '2468', true)?.x).toBe(76);
      expect(await page.locator('#asteroid-tools-launcher, #asteroid-tools-overlay').count()).toBe(
        0
      );
      expect(
        await page
          .locator('#flight-feedback')
          .evaluate((element) => getComputedStyle(element).pointerEvents)
      ).toBe('none');
      await saveScreenshot(
        page,
        screenshotManager.getScreenshotPath('hud-composition-landscape.png')
      );

      expect(consoleErrors).toEqual([]);
    } finally {
      if (wasRunning !== undefined) {
        await page.evaluate((running) => {
          document.getElementById('safe-area-probe')?.removeAttribute('style');
          const gameController = window.gameController;
          if (!gameController) {
            return;
          }
          gameController.getGameStateManager().clearOverlay();
          gameController.getGameStateManager().setIsGameRunning(running);
        }, wasRunning);
      }
    }
  },
  TestConfig.DEFAULT_TIMEOUT
);
