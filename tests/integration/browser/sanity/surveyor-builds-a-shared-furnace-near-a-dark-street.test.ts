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

for (const viewport of [
  { width: 1280, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
]) {
  test(`a Surveyor builds a shared furnace near a dark street at ${viewport.width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.navigateToGame();
    await page.locator('[data-kit-id="surveyor"]').click();
    await game.startGame();
    await game.waitForGameReady();
    await game.waitForServerJoin();
    const store = page.locator('#town-store-dialog');
    if (viewport.touch) {
      await page.waitForFunction(
        () => document.querySelector('#touch-ability')?.textContent?.includes('ENTER') === true
      );
      await page.locator('#touch-ability').tap();
    } else {
      await page.keyboard.press('KeyE');
    }
    await store.waitFor({ state: 'visible' });
    expect(await store.textContent()).toContain('Ember');
    await page.locator('#town-store-return').click();
    await store.waitFor({ state: 'hidden' });
    const openSchematic = async () => {
      const toggle = page.locator('#ship-schematic-toggle');
      if (viewport.touch) {
        await toggle.tap();
      } else {
        await toggle.click();
      }
      await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
    };
    await openSchematic();
    expect(await page.locator('[data-utility-id="build_furnace"]').count()).toBe(0);
    expect(await page.locator('[data-utility-id]').count()).toBe(2);
    expect(await page.locator('#ship-schematic-dialog').textContent()).toContain('Mineral Scan');
    expect(await page.locator('#ship-schematic-dialog').textContent()).toContain('Survey Probe');
    await page.locator('#ship-schematic-return').click();
    await page.locator('#ship-schematic-dialog').waitFor({ state: 'hidden' });
    const lot = civicLot('street-1-0');
    if (!lot) {
      throw new Error('Missing street lot');
    }
    await arrangeCrewField([await game.getLocalPlayerId()], 'street-build');
    await page.waitForFunction(({ x, y }) => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      return Boolean(
        ship && Math.abs(ship.position.x - x) < 20 && Math.abs(ship.position.y - y) < 20
      );
    }, lot.position);
    if (viewport.touch) {
      await page.waitForFunction(
        () => document.querySelector('#touch-ability')?.textContent?.includes('BUILD') === true
      );
      expect(await page.locator('#touch-ability').textContent()).toContain('BUILD');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`surveyor-ability-build-${viewport.width}.png`),
      });
      await page.locator('#touch-ability').tap();
    } else {
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`surveyor-ability-build-${viewport.width}.png`),
      });
      await page.keyboard.press('KeyE');
    }
    await page.waitForFunction((streetName) => {
      const message = window.gameController?.getGameStateManager().getPickupMessage() ?? '';
      return message.includes(streetName) && message.includes('is burning');
    }, lot.name);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`surveyor-lit-street-${viewport.width}.png`),
    });
    await page.goto(`${new URL(page.url()).origin}/wiki/#surveyor`);
    const buildHeading = page.getByRole('heading', { name: 'Build', exact: true });
    await buildHeading.waitFor();
    await buildHeading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`surveyor-wiki-${viewport.width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  }, 60_000);
}
