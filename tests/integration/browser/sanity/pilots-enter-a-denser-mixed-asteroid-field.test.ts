// @vitest-environment node
import { expect, test } from 'vitest';
import { DEPOSIT_FIELD } from '../../../../src/constants';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { width: 1280, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
]) {
  test(`a ${viewport.width}-pixel pilot receives the denser field with moving and stationary rocks`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    // The old even field held about 214 rocks inside this delivery circle;
    // even the calm launch neighborhood is denser.
    await page.waitForFunction(
      () => (window.gameController?.getCurrRoidBelt().getRoids().length ?? 0) >= 240,
      undefined,
      { timeout: 10000 }
    );
    const mix = await page.evaluate(() => {
      const rocks = window.gameController?.getCurrRoidBelt().getRoids() ?? [];
      return {
        total: rocks.length,
        stationary: rocks.filter((rock) => Math.hypot(rock.velocity.x, rock.velocity.y) < 0.001)
          .length,
      };
    });
    expect(mix.stationary / mix.total).toBeGreaterThan(0.1);
    // Rich cores hold more stationary reef rocks; drifters still dominate every field.
    expect(mix.stationary / mix.total).toBeLessThan(DEPOSIT_FIELD.STATIONARY_FRACTION_PEAK);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`dense-field-${viewport.width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  }, 20000);
}
