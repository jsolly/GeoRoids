import { expect, test } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '../../../../src/constants/user-preferences';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`a ${viewport.name} pilot copies a useful report from one compact HUD`, async () => {
    const page = await browserManager.createPage({ hasTouch: viewport.name === 'mobile' });
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize(viewport);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(
      (key) => localStorage.setItem(key, 'true'),
      LOCAL_STORAGE_KEYS.debugOn
    );
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    const copy = page.locator('#copy-debug-diagnostics');
    await copy.waitFor({ state: 'visible' });
    expect(await page.locator('#debug-play-chip').count()).toBe(0);
    if (viewport.name === 'mobile') {
      await copy.tap();
    } else {
      await copy.click();
    }
    await page.waitForFunction(
      () => document.querySelector('#copy-debug-diagnostics')?.textContent === 'Copied!'
    );
    const report = await page.evaluate(() => navigator.clipboard.readText());
    const playerId = await page.evaluate(() => window.gameController?.getCurrPlayer()?.id);
    expect(playerId).toBeTruthy();
    expect(report).toContain(playerId);
    expect(report).toContain('serverOwnsMotion');
    expect(report).toContain('snapshotSequence');
    expect(report).toContain('player_joined');
    const credential = await page.evaluate(() => localStorage.getItem('georoids-resume-token'));
    expect(credential).toBeTruthy();
    expect(report).not.toContain(credential);
    expect(
      await copy.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
        );
      })
    ).toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`diagnostics-${viewport.name}.png`),
    });
    await page.waitForTimeout(1500);
    expect(await copy.textContent()).toBe('Copied!');
    await page.waitForFunction(
      () => document.querySelector('#copy-debug-diagnostics')?.textContent === 'Copy diagnostics'
    );

    // Exercise the real legacy clipboard path when the async API is refused.
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')),
      });
    });
    await copy.click();
    await page.waitForFunction(
      () => document.querySelector('#copy-debug-diagnostics')?.textContent === 'Copied!'
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      'GeoRoids diagnostics\n{\n'
    );
    expect(await page.locator('textarea[style*="fixed"]').count()).toBe(0);

    // A blocked fallback must not claim success.
    await page.evaluate(() => {
      document.execCommand = () => false;
    });
    await copy.click();
    await page.waitForFunction(
      () => document.querySelector('#copy-debug-diagnostics')?.textContent === 'Copy failed'
    );
    await page.waitForFunction(
      () => document.querySelector('#copy-debug-diagnostics')?.textContent === 'Copy diagnostics'
    );
    assertNoBrowserDiagnostics(diagnostics);
  }, 30_000);
}
