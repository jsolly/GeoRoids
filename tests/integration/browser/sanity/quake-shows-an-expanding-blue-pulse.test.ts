import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

declare global {
  interface Window {
    __quakeRadii?: number[];
  }
}

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([1280, 390])(
  'Quake E visibly expands a blue ring across its range at %i pixels',
  async (width) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Quake page unavailable');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height: 900 });
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'quake', waitForCombatReady: false });
    await game.placeShipAt(-1700, 0);
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
      const ctx = canvas?.getContext('2d');
      if (!ctx) {
        throw new Error('Game canvas unavailable');
      }
      window.__quakeRadii = [];
      const originalArc = ctx.arc.bind(ctx);
      ctx.arc = (...args: Parameters<CanvasRenderingContext2D['arc']>) => {
        if (ctx.strokeStyle === '#60a5fa') {
          window.__quakeRadii?.push(args[2]);
        }
        originalArc(...args);
      };
    });
    await page.keyboard.press('KeyE');
    await expect
      .poll(() => page.evaluate(() => window.__quakeRadii?.length ?? 0), { interval: 20 })
      .toBeGreaterThan(4);
    await page.waitForTimeout(180);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`quake-blue-pulse-${width}.png`),
    });
    const radii = await page.evaluate(() => window.__quakeRadii ?? []);
    expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii) * 2);
    expect(Math.max(...radii)).toBeGreaterThan(40);
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);

test(
  'another pilot sees Quake activate through the multiplayer event',
  async () => {
    const observerPage = browserManager.getCurrentPage();
    if (!observerPage) {
      throw new Error('Observer page unavailable');
    }
    const observer = new GameInteractions(observerPage);
    await observer.bootGame({ waitForCombatReady: false });
    await observer.placeShipAt(-1700, 0);
    const quakePage = await browserManager.createAdditionalPage();
    const quake = new GameInteractions(quakePage);
    await quake.bootGame({ kitId: 'quake', waitForCombatReady: false });
    await quake.placeShipAt(-1550, 0);
    await observer.waitForRemoteHumanPlayers(1);
    await observerPage.evaluate(() => {
      const ctx = document.querySelector<HTMLCanvasElement>('#gameCanvas')?.getContext('2d');
      if (!ctx) {
        throw new Error('Game canvas unavailable');
      }
      window.__quakeRadii = [];
      const originalArc = ctx.arc.bind(ctx);
      ctx.arc = (...args: Parameters<CanvasRenderingContext2D['arc']>) => {
        if (ctx.strokeStyle === '#60a5fa') {
          window.__quakeRadii?.push(args[2]);
        }
        originalArc(...args);
      };
    });
    await quakePage.keyboard.press('KeyE');
    await expect
      .poll(() => observerPage.evaluate(() => window.__quakeRadii?.length ?? 0), {
        interval: 20,
        timeout: 3000,
      })
      .toBeGreaterThan(4);
  },
  TestConfig.DEFAULT_TIMEOUT
);
