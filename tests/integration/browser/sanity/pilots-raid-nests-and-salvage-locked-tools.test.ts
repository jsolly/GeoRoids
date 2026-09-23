import { expect, test } from 'vitest';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const width of [1280, 390]) {
  test(`a pilot finds ten nest guards and salvages locked hardware at ${width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: width === 390 });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    await page.waitForFunction(
      () => window.gameController?.getCurrPlayer()?.ship.haulerUtility === 'tow_cable'
    );
    await page.locator('#ship-schematic-toggle').click();
    await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
    const tap = page.locator('[data-utility-id="resource_tap"]');
    const coupling = page.locator('[data-utility-id="boost_coupling"]');
    expect(await tap.isDisabled()).toBe(true);
    expect(await coupling.isDisabled()).toBe(true);
    expect(await page.locator('[data-utility-id="tow_cable"]').isEnabled()).toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`starter-tools-${width}.png`),
    });
    await page.locator('#ship-schematic-return').click();

    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'spider-nest');
    const field = (): Promise<SpiderFieldState> =>
      page.evaluate(
        "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
      );
    await expect.poll(async () => (await field()).spiders.length).toBe(10);
    await expect
      .poll(async () => page.evaluate(() => window.gameController?.getLoot().length ?? 0))
      .toBeGreaterThanOrEqual(7);
    await game.placeShipAt(5000, 4750);
    await game.waitForAnimationFrames(3);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`guarded-cache-${width}.png`),
    });

    const equipmentEpochs = await arrangeCrewField([playerId], 'equipment');
    await page.waitForFunction(
      (epoch) => window.gameController?.getCurrPlayer()?.ship.playerMotion?.epoch === epoch,
      equipmentEpochs.get(playerId)
    );
    await page.waitForFunction(() =>
      window.gameController?.getLoot().some((drop) => drop.kind === 'boost_coupling')
    );
    await game.placeShipAt(370, -650);
    await page.mouse.move(width * 0.95, 300);
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => (window.gameController?.getCurrPlayer()?.ship.lasers.length ?? 0) > 0
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`hardware-and-arcade-lasers-${width}.png`),
    });
    await page.keyboard.up('Space');
    await game.collectEquipment(['resource_tap', 'boost_coupling', 'survey_probe']);
    await page.locator('#ship-schematic-toggle').click();
    await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
    expect(await tap.isEnabled()).toBe(true);
    expect(await coupling.isEnabled()).toBe(true);
    await coupling.click();
    expect(await coupling.getAttribute('aria-pressed')).toBe('true');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`salvaged-tools-${width}.png`),
    });
    await page.locator('#ship-schematic-return').click();
    await page.reload();
    await game.startGame();
    await game.waitForServerJoin();
    await page.waitForFunction(
      () => window.gameController?.getCurrPlayer()?.ship.equipment.length === 3
    );
    assertNoBrowserDiagnostics(diagnostics);
  }, 45000);
}
