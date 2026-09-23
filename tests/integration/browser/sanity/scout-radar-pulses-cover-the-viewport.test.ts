import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { width: 1280, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
]) {
  test(`Scout radar sweeps the ${viewport.width}-pixel viewport and stops when the scan ends`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    await arrangeCrewField([await game.getLocalPlayerId()], 'empty');
    await game.placeShipAt(20000, 20000);
    const probe = await page.evaluateHandle(() => {
      const originalArc = CanvasRenderingContext2D.prototype.arc;
      const canvas = document.querySelector('#gameCanvas');
      const observation = {
        maxRadius: 0,
        samples: 0,
        restore() {
          CanvasRenderingContext2D.prototype.arc = originalArc;
        },
      };
      CanvasRenderingContext2D.prototype.arc = function (
        this: CanvasRenderingContext2D,
        x,
        y,
        radius,
        start,
        end,
        counterclockwise
      ) {
        if (
          this.canvas === canvas &&
          Math.abs(x - window.innerWidth / 2) < 2 &&
          Math.abs(y - window.innerHeight / 2) < 2 &&
          radius > 50
        ) {
          observation.maxRadius = Math.max(observation.maxRadius, radius);
          observation.samples++;
        }
        originalArc.call(this, x, y, radius, start, end, counterclockwise);
      };
      return observation;
    });
    try {
      if (viewport.touch) {
        await page.locator('#touch-ability').tap();
      } else {
        await page.keyboard.press('KeyE');
      }
      await page.waitForFunction(
        () => (window.gameController?.getCurrPlayer()?.ship.abilityActiveFrames ?? 0) > 0
      );
      await expect
        .poll(() => probe.evaluate((value) => value.maxRadius), { timeout: 3500, interval: 16 })
        .toBeGreaterThan(Math.min(viewport.width, viewport.height) * 0.35);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`scout-radar-${viewport.width}.png`),
      });
      await expect
        .poll(() => probe.evaluate((value) => value.maxRadius), { timeout: 6000 })
        .toBeGreaterThanOrEqual(Math.hypot(viewport.width / 2, viewport.height / 2) * 0.98);
      await page.waitForFunction(
        () => window.gameController?.getCurrPlayer()?.ship.abilityActiveFrames === 0,
        undefined,
        { timeout: 8000 }
      );
      await probe.evaluate((value) => {
        value.maxRadius = 0;
        value.samples = 0;
      });
      await game.waitForAnimationFrames(6);
      expect(await probe.evaluate((value) => value.samples)).toBe(0);
      assertNoBrowserDiagnostics(diagnostics);
    } finally {
      await probe.evaluate((value) => value.restore());
      await probe.dispose();
    }
  }, 20000);
}
