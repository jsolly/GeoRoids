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
  { name: 'desktop', width: 1280, height: 900, touch: false },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'landscape', width: 844, height: 390, touch: true },
]) {
  test(`a ${viewport.name} pilot interrupts cyan recharge with a partial amber boost`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize(viewport);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'surveyor' });
    const id = await page.evaluate(() => window.gameController?.getCurrPlayer()?.id);
    if (!id) {
      throw new Error('Missing pilot');
    }
    await arrangeCrewField([id], 'empty');
    await game.waitForAnimationFrames(4);
    const button = page.locator('#touch-boost');
    await button.waitFor({ state: 'visible' });
    await expect.poll(() => button.isEnabled()).toBe(true);
    const activate = () => (viewport.touch ? button.tap() : button.click());
    await activate();
    await page.waitForFunction(() => {
      const boost = window.gameController?.getCurrPlayer()?.ship.boost;
      return boost?.phase === 'active' && boost.charge < 0.65 && boost.charge > 0.3;
    });
    expect(await button.getAttribute('aria-pressed')).toBe('true');
    const activeColor = await button.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--boost-fill').trim()
    );
    expect(activeColor).toBe('#fbbf24');
    const beforeCharge = Number(await button.getAttribute('data-boost-charge'));
    await game.waitForAnimationFrames(6);
    expect(Number(await button.getAttribute('data-boost-charge'))).toBeLessThan(beforeCharge);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-active-${viewport.name}.png`),
    });
    await page.waitForFunction(
      () => window.gameController?.getCurrPlayer()?.ship.boost.phase === 'exhausted',
      undefined,
      { timeout: 5000 }
    );
    await page.waitForFunction(() => {
      const boost = window.gameController?.getCurrPlayer()?.ship.boost;
      return boost?.phase === 'exhausted' && boost.charge > 0.4 && boost.charge < 0.75;
    });
    expect(await button.getAttribute('aria-pressed')).toBe('false');
    expect(
      await button.evaluate((el) => getComputedStyle(el).getPropertyValue('--boost-fill').trim())
    ).toBe('#22d3ee');
    const refilling = Number(await button.getAttribute('data-boost-charge'));
    await game.waitForAnimationFrames(6);
    expect(Number(await button.getAttribute('data-boost-charge'))).toBeGreaterThan(refilling);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-refilling-${viewport.name}.png`),
    });
    await expect.poll(() => button.isEnabled()).toBe(true);
    await activate();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
    const partial = Number(await button.getAttribute('data-boost-charge'));
    expect(partial).toBeLessThan(0.8);
    await game.waitForAnimationFrames(12);
    expect(await button.getAttribute('data-boost-phase')).toBe('active');
    expect(Number(await button.getAttribute('data-boost-charge'))).toBeLessThan(partial);
    expect(
      await button.evaluate((el) => getComputedStyle(el).getPropertyValue('--boost-fill').trim())
    ).toBe('#fbbf24');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-partial-restart-${viewport.name}.png`),
    });
    await activate();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('false');
    await page.waitForFunction(
      () => {
        const boost = window.gameController?.getCurrPlayer()?.ship.boost;
        return boost?.phase === 'idle' && boost.charge === 1;
      },
      undefined,
      { timeout: 6000 }
    );
    await expect.poll(() => button.isEnabled()).toBe(true);
    await activate();
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.boosting))
      .toBe(true);
    await activate();
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.boosting))
      .toBe(false);
    assertNoBrowserDiagnostics(diagnostics);
  }, 20000);
}
