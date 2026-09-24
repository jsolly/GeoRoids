import { expect, test } from 'vitest';
import { computeHudLayout } from '../../../../src/rendering/hud/hudLayout';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])(
  'pilot sees exploration fog while flying at $width pixels',
  async (viewport) => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.width === 390 });
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize(viewport);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await game.holdMovementKey('ArrowRight', 1500);
    const radar = computeHudLayout(viewport, { touchControls: viewport.width === 390 }).miniMap;
    await expect
      .poll(() =>
        page.evaluate((bounds) => {
          const canvas = document.querySelector('#gameCanvas');
          if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error('Expected the running game canvas');
          }
          const display = canvas.getBoundingClientRect();
          const scaleX = canvas.width / display.width;
          const scaleY = canvas.height / display.height;
          // Sample a copy so polling does not change the game's canvas readback mode.
          const sample = document.createElement('canvas');
          sample.width = bounds.size * scaleX;
          sample.height = bounds.size * scaleY;
          const context = sample.getContext('2d', { willReadFrequently: true });
          if (!context) {
            throw new Error('Expected a radar sampling context');
          }
          context.drawImage(
            canvas,
            bounds.x * scaleX,
            bounds.y * scaleY,
            sample.width,
            sample.height,
            0,
            0,
            sample.width,
            sample.height
          );
          const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
          let explored = 0;
          let fog = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            // Broad patches of pale blue ground must coexist with dark unexplored cells.
            // Tiny colored ship/resource marks cannot satisfy the area threshold.
            if (red >= 20 && red <= 30 && green >= 35 && green <= 45 && blue >= 55 && blue <= 70) {
              explored++;
            }
            if (red === 0 && green === 0 && blue === 17) {
              fog++;
            }
          }
          const minimumArea = 100 * scaleX * scaleY;
          return explored > minimumArea && fog > minimumArea;
        }, radar)
      )
      .toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`radar-fog-${viewport.width}.png`),
    });
    await page.locator('#universe-map-toggle').click();
    await page.locator('#universe-map-dialog').waitFor({ state: 'visible' });
    await page.locator('#universe-map-close').click();
    await page.locator('#universe-map-dialog').waitFor({ state: 'hidden' });
    await page.goto(`${TestConfig.GAME_URL}/wiki/#hud-network`);
    await expect
      .poll(() => page.locator('body').textContent())
      .toContain('Explored ground has a pale blue tint');
    await page
      .locator('p')
      .filter({ hasText: 'Explored ground has a pale blue tint' })
      .evaluate((paragraph) => paragraph.scrollIntoView({ block: 'start' }));
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`radar-fog-wiki-${viewport.width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
