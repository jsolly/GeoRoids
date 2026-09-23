import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';
import { centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([
  { width: 1280, menu: 'map' },
  { width: 390, menu: 'map' },
  { width: 1280, menu: 'schematic' },
  { width: 390, menu: 'schematic' },
] as const)(
  'the $menu holds flight at $width pixels, ignores rocks, and blinks on return',
  async ({ width, menu }) => {
    const page =
      width === 390
        ? await browserManager.recreatePage({ hasTouch: true })
        : browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Browser unavailable');
    }
    await page.setViewportSize({ width, height: 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'hauler' });
    const id = await game.getLocalPlayerId();
    await arrangeCrewField([id], 'empty');
    await game.waitForAnimationFrames(20);
    if (width === 1280) {
      await page.keyboard.press(menu === 'map' ? 'm' : 'v');
    } else if (menu === 'map') {
      await page.locator('#universe-map-toggle').tap();
    } else {
      await page.locator('#ship-schematic-toggle').tap();
    }
    const dialog = page.locator(menu === 'map' ? '#universe-map-dialog' : '#ship-schematic-dialog');
    await expect.poll(() => dialog.isVisible()).toBe(true);
    const pose = () =>
      page.evaluate(() => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        if (!ship) {
          throw new Error('Ship missing');
        }
        return {
          position: { ...ship.position },
          velocity: { ...ship.velocity },
          angle: ship.angle,
          thrusting: ship.thrusting,
          movementLocked: ship.movementLocked,
        };
      });
    await game.waitForAnimationFrames(3);
    const held = await pose();
    expect(held.movementLocked).toBe(true);
    if (width === 390) {
      const session = await page.context().newCDPSession(page);
      try {
        const center = await centerOf(
          page,
          menu === 'map' ? '#universe-map-dialog' : '#ship-schematic-dialog'
        );
        await dispatchTouch(session, 'touchStart', [{ ...center, id: 2 }]);
        await dispatchTouch(session, 'touchMove', [{ x: center.x + 40, y: center.y - 40, id: 2 }]);
        await game.waitForAnimationFrames(60);
      } finally {
        await dispatchTouch(session, 'touchEnd', []);
        await session.detach();
      }
    } else {
      await page.keyboard.down('ArrowLeft');
      try {
        await game.waitForAnimationFrames(60);
      } finally {
        await page.keyboard.up('ArrowLeft');
      }
    }
    expect(await pose()).toEqual(held);
    expect(held.velocity).toEqual({ x: 0, y: 0 });
    expect(held.thrusting).toBe(false);
    const health = await game.getShipHealth();
    await arrangeCrewField([id], 'impact');
    await game.waitForAnimationFrames(30);
    expect(await game.getShipHealth()).toBe(health);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`stationary-${menu}-${width}.png`),
    });
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.blinkCount ?? 0))
      .toBeGreaterThan(0);
    expect((await pose()).movementLocked).toBe(false);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`blink-return-${menu}-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
