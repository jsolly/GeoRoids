import { expect, test } from 'vitest';
import { STEERING } from '../../../../src/constants';
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
    await game.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    await arrangeCrewField([await game.getLocalPlayerId()], 'empty');
    const schematicToggle = page.locator('#ship-schematic-toggle');
    if (viewport.touch) {
      expect(await schematicToggle.isVisible()).toBe(false);
      const hintLines = await page.evaluate(() => {
        const canvasElement = document.querySelector('#gameCanvas');
        const original = CanvasRenderingContext2D.prototype.fillText;
        const texts: { text: string; y: number }[] = [];
        CanvasRenderingContext2D.prototype.fillText = function (
          this: CanvasRenderingContext2D,
          text: string,
          x: number,
          y: number,
          maxWidth?: number
        ): void {
          if (this.canvas === canvasElement) {
            texts.push({ text, y });
          }
          original.call(this, text, x, y, maxWidth);
        };
        try {
          window.gameController?.renderGame();
        } finally {
          CanvasRenderingContext2D.prototype.fillText = original;
        }
        return texts;
      });
      const hold = hintLines.find((line) => line.text === 'Tap and hold your ship');
      const equip = hintLines.find((line) => line.text === 'to equip tools');
      expect(hold).toBeDefined();
      expect(equip).toBeDefined();
      expect(equip?.y).toBeLessThan(viewport.height / 2 - STEERING.ARROW_DISTANCE_PX);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`join-hint-${viewport.width}.png`),
      });
      const touch = await page.context().newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: viewport.width / 2, y: viewport.height / 2 }],
      });
      await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await touch.detach();
    } else {
      expect(await schematicToggle.isVisible()).toBe(true);
      expect(await page.locator('#ship-schematic-toggle kbd').isVisible()).toBe(true);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`schematic-button-${viewport.width}.png`),
      });
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
        const modal = document.querySelector('#ship-schematic-dialog');
        if (!(cards instanceof HTMLElement) || !inventory || !(modal instanceof HTMLElement)) {
          throw new Error('Missing schematic content');
        }
        return {
          cardsBottom: cards.getBoundingClientRect().bottom,
          inventoryTop: inventory.getBoundingClientRect().top,
          width: modal.clientWidth,
          contentWidth: modal.scrollWidth,
          clippedNames: [...cards.querySelectorAll('.ship-schematic-card-name')].some(
            (name) => name.scrollWidth > name.clientWidth || name.scrollHeight > name.clientHeight
          ),
        };
      });
      expect(layout.inventoryTop).toBeGreaterThanOrEqual(layout.cardsBottom);
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
  }, 20000);
}
