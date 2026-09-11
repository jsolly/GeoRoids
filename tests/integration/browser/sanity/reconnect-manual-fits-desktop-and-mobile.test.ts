import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`the reconnect manual remains readable on ${viewport.name}`, async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page unavailable');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize(viewport);
    await page.goto(`${TestConfig.GAME_URL}/wiki/#hud-network`);
    const instructions = page.getByText('Keep the game tab up to date.', { exact: false });
    await instructions.waitFor({ state: 'visible' });
    await instructions.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.goto(`${TestConfig.GAME_URL}/wiki/#hauler`);
    expect(await page.locator('.demo button').count()).toBe(0);
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(/\.gif$/);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`performance-wiki-${viewport.name}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  });
}
