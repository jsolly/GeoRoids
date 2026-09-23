import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

function field(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
  );
}

for (const width of [1280, 390]) {
  test(`a spider bites through a Hauler's cable to free its companion at ${width}px`, async () => {
    const mobile = width === 390;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'hauler', haulerUtility: 'tow_cable', waitForCombatReady: false });
    const id = await game.getLocalPlayerId();
    await arrangeCrewField([id], 'spider-rescue');
    await expect.poll(async () => (await field(page)).spiders.length).toBe(2);
    const spiders = (await field(page)).spiders.sort((a, b) => a.position.y - b.position.y);
    const captive = spiders[0];
    const rescuer = spiders[1];
    if (!captive || !rescuer) {
      throw new Error('Expected captive and rescuer');
    }
    if (mobile) {
      await page.locator('#touch-ability').tap();
    } else {
      await page.keyboard.press('e');
    }
    const latch = () =>
      page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId);
    await expect.poll(latch).toBe(captive.id);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-rescue-tow-${width}.png`),
    });
    await expect.poll(latch, { timeout: 15000 }).toBeNull();
    const freed = (await field(page)).spiders.find((spider) => spider.id === captive.id);
    expect(freed?.health).toBeGreaterThan(0);
    const helper = (await field(page)).spiders.find((spider) => spider.id === rescuer.id);
    expect(helper?.health).toBeGreaterThan(0);
    expect(helper?.position.y).toBeLessThan(rescuer.position.y - 50);
    expect(await game.getShipHealth()).toBeGreaterThan(0);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-rescue-freed-${width}.png`),
    });
    for (const article of ['terrain', 'hauler']) {
      await page.goto(`${TestConfig.GAME_URL}/wiki/#${article}`);
      const rescueRule = page.locator('p').filter({ hasText: 'Towing a living spider' }).last();
      await rescueRule.waitFor({ state: 'visible' });
      await rescueRule.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`spider-rescue-wiki-${article}-${width}.png`),
      });
    }
    assertNoBrowserDiagnostics(diagnostics);
  }, 60000);
}
