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
  { width: 390, height: 650, touch: true },
]) {
  test(`Hauler tools remain readable and show the coupling launch at ${viewport.width} pixels`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.navigateToGame();
    const kitButton = page.locator('[data-kit-id="hauler"]');
    await kitButton.waitFor({ state: 'visible', timeout: 5000 });
    await kitButton.click();
    await game.startGame();
    await game.waitForGameReady();
    await game.waitForServerJoin();
    const schematicToggle = page.locator('#ship-schematic-toggle');
    await schematicToggle.waitFor({ state: 'visible' });
    expect(await schematicToggle.textContent()).toContain('Inventory');
    const buttonBox = await schematicToggle.boundingBox();
    if (!buttonBox) {
      throw new Error('Missing Inventory button bounds');
    }
    expect(buttonBox.x).toBeGreaterThanOrEqual(0);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(viewport.height);
    if (viewport.touch) {
      const touch = await page.context().newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: viewport.width / 2, y: viewport.height / 2 }],
      });
      await page.waitForTimeout(900);
      expect(await page.locator('#ship-schematic-dialog').isVisible()).toBe(false);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await touch.detach();
      expect(await page.locator('#ship-schematic-toggle kbd').isVisible()).toBe(false);
    } else {
      expect(await page.locator('#ship-schematic-toggle kbd').isVisible()).toBe(true);
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`inventory-button-${viewport.width}.png`),
    });
    await game.waitForNetworkAsteroids(1);
    await game.collectEquipment(['resource_tap', 'boost_coupling']);
    await arrangeCrewField([await game.getLocalPlayerId()], 'empty');
    if (viewport.touch) {
      await schematicToggle.tap();
    } else {
      await schematicToggle.click();
    }
    const dialog = page.locator('#ship-schematic-dialog');
    for (const utility of ['tow_cable', 'resource_tap', 'boost_coupling']) {
      const card = page.locator(`[data-utility-id="${utility}"]`);
      if (viewport.touch) {
        await card.tap();
      } else {
        await card.click();
      }
      expect(await card.getAttribute('aria-pressed')).toBe('true');
      const layout = await page.evaluate(() => {
        const cards = document.querySelector('#ship-schematic-cards');
        const inventory = document.querySelector('.satellite-inventory');
        const canvas = document.querySelector('#ship-schematic-canvas');
        const modal = document.querySelector('#ship-schematic-dialog');
        if (
          !(cards instanceof HTMLElement) ||
          !(inventory instanceof HTMLElement) ||
          !(canvas instanceof HTMLElement) ||
          !(modal instanceof HTMLElement)
        ) {
          throw new Error('Missing schematic content');
        }
        const cardsBox = cards.getBoundingClientRect();
        const inventoryBox = inventory.getBoundingClientRect();
        const canvasBox = canvas.getBoundingClientRect();
        const modalBox = modal.getBoundingClientRect();
        const copy = inventory.querySelector(':scope > p');
        if (!(copy instanceof HTMLElement)) {
          throw new Error('Missing inventory copy');
        }
        const copyBox = copy.getBoundingClientRect();
        return {
          inventoryBesideHull: inventoryBox.left >= canvasBox.right - 2,
          inventoryBelowHull: inventoryBox.top >= canvasBox.bottom - 4,
          copyUsesPanel: copyBox.width >= modalBox.width * 0.72,
          inventoryInView: inventoryBox.top < modalBox.bottom && inventoryBox.bottom > modalBox.top,
          cardsBelow:
            cardsBox.top >= canvasBox.bottom - 2 && cardsBox.top >= inventoryBox.bottom - 2,
          width: modal.clientWidth,
          contentWidth: modal.scrollWidth,
          clippedNames: [...cards.querySelectorAll('.ship-schematic-card-name')].some(
            (name) => name.scrollWidth > name.clientWidth || name.scrollHeight > name.clientHeight
          ),
        };
      });
      if (viewport.touch) {
        expect(layout.inventoryBelowHull).toBe(true);
        expect(layout.copyUsesPanel).toBe(true);
      } else {
        expect(layout.inventoryBesideHull).toBe(true);
      }
      expect(layout.inventoryInView).toBe(true);
      expect(layout.cardsBelow).toBe(true);
      expect(layout.contentWidth).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.clippedNames).toBe(false);
      await dialog.evaluate((el) => el.scrollTo(0, 0));
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`schematic-${utility}-${viewport.width}.png`),
      });
    }
    const demo = page.locator('#ship-schematic-tool');
    await demo.scrollIntoViewIfNeeded();
    for (const phase of [
      { name: 'turn', start: 500, end: 650 },
      { name: 'ignite', start: 900, end: 1050 },
      { name: 'away', start: 1900, end: 2100 },
    ]) {
      await page.waitForFunction(({ start, end }) => {
        const frame = performance.now() % 3200;
        return frame >= start && frame <= end;
      }, phase);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`coupling-${phase.name}-${viewport.width}.png`),
      });
    }
    const back = page.getByRole('button', { name: 'Return to flight' });
    if (viewport.touch) {
      await back.tap();
    } else {
      await back.click();
    }
    expect(await dialog.isVisible()).toBe(false);
    assertNoBrowserDiagnostics(diagnostics);
  }, 40000);
}

test('a short touch screen keeps all action buttons at the top', async () => {
  const width = 844;
  const height = 390;
  const page = await browserManager.recreatePage({ hasTouch: true });
  await page.setViewportSize({ width, height });
  const game = new GameInteractions(page);
  await game.navigateToGame();
  await page.locator('[data-kit-id="hauler"]').click();
  await game.startGame();
  await game.waitForGameReady();
  const toggle = page.locator('#ship-schematic-toggle');
  await toggle.waitFor({ state: 'visible' });
  for (const id of [
    'ship-schematic-toggle',
    'universe-map-toggle',
    'touch-boost',
    'touch-ability',
  ]) {
    const box = await page.locator(`#${id}`).boundingBox();
    if (!box) {
      throw new Error(`Missing ${id}`);
    }
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThan(height / 2);
  }
  await page.screenshot({
    path: screenshotManager.getScreenshotPath('inventory-button-short-touch.png'),
  });
});
