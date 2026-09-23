import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { TOWN_HEARTH } from '../../../../shared/furnaces';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
function field(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
  );
}
for (const width of [1280, 390]) {
  test(`a Hauler extracts silk and tows a spider into the furnace at ${width}px`, async () => {
    const mobile = width === 390;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({
      kitId: 'hauler',
      waitForCombatReady: false,
    });
    await game.collectEquipment(['resource_tap'], 'resource_tap');
    const id = await game.getLocalPlayerId();
    const use = () => (mobile ? page.locator('#touch-ability').tap() : page.keyboard.press('e'));
    const open = async () => {
      if (mobile) {
        await page.locator('#ship-schematic-toggle').tap();
      } else {
        await page.keyboard.press('v');
      }
      await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
    };
    const works = TOWN_HEARTH;
    const arrange = async (angle: number) => {
      await arrangeCrewField([id], 'spider-tools');
      await game.placeShipAt(works.position.x + 400, works.position.y);
      await page.evaluate((heading) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        if (!ship) {
          throw new Error('Missing local Hauler');
        }
        ship.angle = heading;
        ship.angularVelocity = 0;
      }, angle);
      await expect.poll(async () => (await field(page)).spiders.length).toBe(1);
    };
    await arrange(0);
    const target = (await field(page)).spiders[0];
    if (!target) {
      throw new Error('Missing spider');
    }
    await use();
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId))
      .toBe(target.id);
    await expect
      .poll(
        async () =>
          (await field(page)).spiders.find((spider) => spider.id === target.id)?.shudderFrames ?? 0
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: screenshotManager.getScreenshotPath(`spider-tap-${width}.png`) });
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.silk ?? 0), {
        timeout: 10000,
      })
      .toBeGreaterThan(0);
    await open();
    expect(await page.locator('.satellite-inventory-silk').textContent()).toMatch(
      /Spider silk: [1-9]/u
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-silk-inventory-${width}.png`),
    });
    await page.locator('[data-utility-id="tow_cable"]').click();
    await page.locator('#ship-schematic-return').click();
    await arrange(Math.PI);
    const cargo = (await field(page)).spiders[0];
    if (!cargo) {
      throw new Error('Missing tow target');
    }
    await use();
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId))
      .toBe(cargo.id);
    await expect
      .poll(
        async () =>
          (await field(page)).spiders.find((spider) => spider.id === cargo.id)?.position.x ??
          Infinity
      )
      .toBeLessThan(cargo.position.x - 10);
    await page.screenshot({ path: screenshotManager.getScreenshotPath(`spider-tow-${width}.png`) });
    await expect
      .poll(
        async () =>
          (await field(page)).consumed?.some(
            (event) => event.id === cargo.id && event.furnaceId === TOWN_HEARTH.id
          ),
        { timeout: 20000 }
      )
      .toBe(true);
    expect((await field(page)).spiders.some((spider) => spider.id === cargo.id)).toBe(false);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-furnace-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  }, 60000);
}
