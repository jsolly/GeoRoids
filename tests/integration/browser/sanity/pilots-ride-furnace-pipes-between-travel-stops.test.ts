import { expect, test } from 'vitest';
import { civicLot } from '../../../../shared/furnaces';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const width of [1280, 390]) {
  test(`a pilot rides a rocket from a built furnace to Town Square and back at ${width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: width === 390 });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    const lot = civicLot('street-1-0');
    if (!lot) {
      throw new Error('Missing street travel fixture');
    }
    const id = await game.getLocalPlayerId();
    await arrangeCrewField([id], 'street-travel');
    await page.waitForFunction(({ x, y }) => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      return ship && Math.hypot(ship.position.x - x, ship.position.y - y) < 20;
    }, lot.position);
    await page.keyboard.press('KeyE');
    await expect
      .poll(
        () =>
          page.evaluate(
            "import('/src/network/worldExploration.ts').then(({worldFurnaces}) => worldFurnaces.isLit('street-1-0'))"
          ),
        { timeout: 5000 }
      )
      .toBe(true);
    const prompt = page.locator('#furnace-travel-prompt');
    await prompt.waitFor({ state: 'visible' });
    expect(await prompt.textContent()).toBe(
      width === 390 ? 'Tap TRAVEL to open map' : 'Press E to travel'
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`furnace-travel-prompt-${width}.png`),
    });
    if (width === 390) {
      expect(await page.locator('#touch-ability').textContent()).toContain('TRAVEL');
      await page.locator('#touch-ability').tap();
    } else {
      await page.keyboard.press('KeyE');
    }
    const menu = page.getByRole('dialog', { name: 'Furnace travel' });
    await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(async (error: unknown) => {
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`travel-menu-error-${width}.png`),
      });
      throw error;
    });
    await menu
      .getByRole('region', { name: /^Furnace destination map/u })
      .waitFor({ state: 'visible' });
    await prompt.waitFor({ state: 'hidden' });
    const home = menu.locator('[data-furnace-id="town-square"]');
    expect(await home.isEnabled()).toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`furnace-destinations-${width}.png`),
    });
    if (width === 390) {
      await home.tap();
    } else {
      await home.click();
    }
    await page.waitForFunction(() =>
      Boolean(window.gameController?.getCurrPlayer()?.ship.furnaceTransit)
    );
    await page.keyboard.press('KeyV');
    expect(await page.locator('#ship-schematic-dialog').isVisible()).toBe(false);
    await game.waitForAnimationFrames(3);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`rocket-pipe-ride-${width}.png`),
    });
    await page.waitForFunction(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      return ship && !ship.furnaceTransit && Math.hypot(ship.position.x, ship.position.y) < 220;
    });
    await page.keyboard.press('KeyE');
    await menu.waitFor({ state: 'visible' });
    const scoreBefore = await page.evaluate(
      () => window.gameController?.getCurrPlayer()?.score ?? 0
    );
    await menu.locator('[data-offer="placeholder-1"]').click();
    await page.waitForFunction(() =>
      window.gameController?.getCurrPlayer()?.purchases.includes('placeholder-1')
    );
    expect(await page.evaluate(() => window.gameController?.getCurrPlayer()?.score)).toBe(
      scoreBefore - 100
    );
    const back = menu.locator('[data-furnace-id="street-1-0"]');
    expect(await back.isEnabled()).toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`town-travel-and-lives-${width}.png`),
    });
    await back.click();
    await page.waitForFunction(({ x, y }) => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      return (
        ship && !ship.furnaceTransit && Math.hypot(ship.position.x - x, ship.position.y - y) < 220
      );
    }, lot.position);
    await game.placeShipAt(lot.position.x + lot.radius + 10, lot.position.y);
    await prompt.waitFor({ state: 'hidden' });
    expect(await page.locator('#touch-ability').textContent()).not.toContain('TRAVEL');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`outside-furnace-footprint-${width}.png`),
    });
    await game.placeShipAt(lot.position.x, lot.position.y);
    await prompt.waitFor({ state: 'visible' });
    assertNoBrowserDiagnostics(diagnostics);
  }, 30000);
}
