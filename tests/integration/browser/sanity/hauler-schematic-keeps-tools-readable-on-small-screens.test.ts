import { expect, test } from 'vitest';
import { playfieldToggleOffsets } from '../../../../src/rendering/canvasSurface';
import { hudLayoutForCanvas } from '../../../../src/rendering/hud/hudLayout';
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
        return {
          inventoryBesideHull: inventoryBox.left >= canvasBox.right - 2,
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
      expect(layout.inventoryBesideHull).toBe(true);
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

test('a short touch screen keeps Inventory under the radar and above Map', async () => {
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
  const expected = playfieldToggleOffsets(
    hudLayoutForCanvas({ width, height }).miniMap,
    true,
    height
  );
  const stack = await page.evaluate(() => {
    const area = document.querySelector('#gameArea');
    const inventory = document.querySelector('#ship-schematic-toggle');
    const map = document.querySelector('#universe-map-toggle');
    if (
      !(area instanceof HTMLElement) ||
      !(inventory instanceof HTMLElement) ||
      !(map instanceof HTMLElement)
    ) {
      throw new Error('Missing playfield controls');
    }
    const inventoryBox = inventory.getBoundingClientRect();
    const mapBox = map.getBoundingClientRect();
    return {
      schematicY: Number.parseFloat(area.style.getPropertyValue('--schematic-toggle-y')),
      mapY: Number.parseFloat(area.style.getPropertyValue('--map-toggle-y')),
      inventoryBottom: inventoryBox.bottom,
      inventoryRight: inventoryBox.right,
      mapTop: mapBox.top,
      width: window.innerWidth,
    };
  });
  expect(stack.schematicY).toBe(expected.schematicY);
  expect(stack.mapY).toBe(expected.mapY);
  expect(stack.inventoryBottom).toBeLessThanOrEqual(stack.mapTop + 1);
  expect(stack.inventoryRight).toBeLessThanOrEqual(stack.width + 1);
  await page.screenshot({
    path: screenshotManager.getScreenshotPath('inventory-button-short-touch.png'),
  });
});
