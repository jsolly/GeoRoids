import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
const GIF_SRC_SUFFIX_PATTERN = /\.gif$/u;

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
    const instructions = page.getByText('Reload when the game requests an update.', {
      exact: false,
    });
    await instructions.waitFor({ state: 'visible' });
    await instructions.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.goto(`${TestConfig.GAME_URL}/wiki/#hauler`);
    expect(await page.locator('.demo button').count()).toBe(0);
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(
      GIF_SRC_SUFFIX_PATTERN
    );
    const reference = page.locator('details.game-reference');
    const referenceRules = reference.locator('section').first();
    expect(await reference.getAttribute('open')).toBeNull();
    expect(await referenceRules.isVisible()).toBe(false);
    const summary = reference.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    expect(await referenceRules.isVisible()).toBe(true);
    expect(await reference.textContent()).toContain('Resource Tap ejects');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`performance-wiki-${viewport.name}.png`),
    });
    await page.keyboard.press('Space');
    expect(await reference.getAttribute('open')).toBeNull();
    expect(await referenceRules.isVisible()).toBe(false);
    assertNoBrowserDiagnostics(diagnostics);
  });
}
