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
  'the $menu holds flight through respawns at $width pixels and game over returns Home',
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
    await game.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    const id = await game.getLocalPlayerId();
    await arrangeCrewField([id], 'empty');
    await game.waitForAnimationFrames(20);
    if (width === 1280) {
      await page.keyboard.press(menu === 'map' ? 'm' : 'v');
    } else if (menu === 'map') {
      await page.locator('#universe-map-toggle').tap();
    } else {
      const session = await page.context().newCDPSession(page);
      try {
        const center = await centerOf(page, '#gameCanvas');
        await dispatchTouch(session, 'touchStart', [{ ...center, id: 1 }]);
        await page.waitForFunction(() =>
          document.querySelector('#ship-schematic-dialog')?.hasAttribute('open')
        );
      } finally {
        await dispatchTouch(session, 'touchEnd', []);
        await session.detach();
      }
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
        };
      });
    await game.waitForAnimationFrames(3);
    const held = await pose();
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
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`stationary-${menu}-${width}.png`),
    });
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await game.waitForAnimationFrames(20);
    expect((await pose()).position).not.toEqual(held.position);
    // A real server asteroid impact while the menu is reopened must cost a life.
    await page.keyboard.press(menu === 'map' ? 'm' : 'v');
    await expect.poll(() => dialog.isVisible()).toBe(true);
    const lives = await game.getLives();
    await arrangeCrewField([id], 'impact');
    await expect.poll(() => game.getLives(), { timeout: 8000 }).toBe(lives - 1);
    // Surviving lives respawn with this same menu open and navigation still locked.
    for (let remaining = lives - 1; remaining > 0; remaining--) {
      await game.waitForShipAlive();
      await game.waitForAnimationFrames(5);
      expect(await dialog.isVisible()).toBe(true);
      const respawned = await pose();
      await game.waitForAnimationFrames(30);
      expect(await pose()).toEqual(respawned);
      expect(respawned.velocity).toEqual({ x: 0, y: 0 });
      await arrangeCrewField([id], 'impact');
      await expect.poll(() => game.getLives(), { timeout: 8000 }).toBe(remaining - 1);
    }
    await expect
      .poll(() => page.locator('#start-screen').isVisible(), { timeout: 1500 })
      .toBe(true);
    expect(await dialog.isVisible()).toBe(false);
    expect(await page.locator('#gameArea').isVisible()).toBe(false);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`menu-game-over-home-${menu}-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
