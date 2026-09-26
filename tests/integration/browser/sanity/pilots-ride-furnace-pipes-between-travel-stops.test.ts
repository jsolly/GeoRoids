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
  test(`a pilot rides their ship from a built furnace to Town Square and back at ${width}px`, async () => {
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
    expect(await prompt.locator(width === 390 ? 'button' : 'span').textContent()).toBe(
      width === 390 ? 'Tap to travel' : 'Press E to travel'
    );
    expect(await page.locator('[data-audio-restart]').count()).toBe(0);
    await page.keyboard.down('ArrowRight');
    try {
      await game.waitForAnimationFrames(10);
    } finally {
      await page.keyboard.up('ArrowRight');
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`furnace-travel-prompt-${width}.png`),
    });
    if (width === 390) {
      const ability = page.locator('#touch-ability');
      expect(await ability.textContent()).toBe('SCAN');
      await ability.tap();
      await page.waitForFunction(
        () => (window.gameController?.getCurrPlayer()?.ship.abilityCooldownFrames ?? 0) > 0
      );
      expect(await page.locator('#town-store-dialog').isVisible()).toBe(false);
      await prompt.getByRole('button', { name: 'Tap to travel' }).tap();
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
    const rotation = await page.evaluate<number>(
      "import('/src/rendering/canvasSurface.ts').then(({canvasManager}) => canvasManager.getCameraRotation())"
    );
    expect(Math.abs(rotation)).toBeGreaterThan(0.1);
    const mapBearing = await page.evaluate(() => {
      const current = document.querySelector('[aria-current="location"].furnace-travel-marker');
      const destination = document.querySelector('[data-furnace-id="town-square"]');
      if (!(current instanceof HTMLElement) || !(destination instanceof HTMLElement)) {
        throw new Error('Missing furnace map bearings');
      }
      return {
        x: Number.parseFloat(destination.style.left) - Number.parseFloat(current.style.left),
        y: Number.parseFloat(destination.style.top) - Number.parseFloat(current.style.top),
      };
    });
    const homeBearing = Math.atan2(-lot.position.y, -lot.position.x) + rotation;
    expect(Math.atan2(mapBearing.y, mapBearing.x)).toBeCloseTo(
      Math.atan2(Math.sin(homeBearing), Math.cos(homeBearing)),
      3
    );
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
    expect(
      await page.evaluate(
        () => window.gameController?.getCurrPlayer()?.ship.furnaceTransit?.durationMs
      )
    ).toBe(3_000);
    await page.keyboard.press('KeyV');
    expect(await page.locator('#ship-schematic-dialog').isVisible()).toBe(false);
    await game.waitForAnimationFrames(3);
    const transitHeading = await page.evaluate<number>(
      `import('/src/rendering/canvasSurface.ts').then(({canvasManager}) => {
        const ship = window.gameController.getCurrPlayer().ship;
        if (!ship.furnaceTransit) throw new Error('Missing active pipe ride');
        return ship.angle - canvasManager.getCameraRotation();
      })`
    );
    expect(transitHeading).toBeCloseTo(Math.PI / 2, 2);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`rocket-pipe-ride-${width}.png`),
    });
    await page.waitForFunction(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      return ship && !ship.furnaceTransit && Math.hypot(ship.position.x, ship.position.y) < 220;
    });
    if (width === 390) {
      await prompt.getByRole('button', { name: 'Enter', exact: true }).tap();
    } else {
      expect(await prompt.locator('span').textContent()).toBe('Press E to enter');
      await page.keyboard.press('KeyE');
    }
    const townMenu = page.getByRole('dialog', { name: 'Town Square', exact: true });
    await townMenu.waitFor({ state: 'visible' });
    expect(await townMenu.locator('#town-store-offer').isVisible()).toBe(false);
    expect(await townMenu.locator('#town-store-travel').isVisible()).toBe(false);
    await page.screenshot({ path: screenshotManager.getScreenshotPath(`town-entry-${width}.png`) });
    await townMenu.getByRole('button', { name: 'Store', exact: true }).click();
    const store = page.getByRole('dialog', { name: 'Store', exact: true });
    await store.waitFor({ state: 'visible' });
    const scoreBefore = await page.evaluate(
      () => window.gameController?.getCurrPlayer()?.score ?? 0
    );
    await store.locator('[data-offer="placeholder-1"]').click();
    await page.waitForFunction(() =>
      window.gameController?.getCurrPlayer()?.purchases.includes('placeholder-1')
    );
    expect(await page.evaluate(() => window.gameController?.getCurrPlayer()?.score)).toBe(
      scoreBefore - 100
    );
    await page.screenshot({ path: screenshotManager.getScreenshotPath(`town-store-${width}.png`) });
    await store.getByRole('button', { name: 'Back to Town Square' }).click();
    await townMenu.getByRole('button', { name: 'Fast Travel', exact: true }).click();
    await menu.waitFor({ state: 'visible' });
    expect(await menu.locator('#town-store-offer').isVisible()).toBe(false);
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
    if (width === 390) {
      for (const viewport of [
        { width: 320, height: 568 },
        { width: 844, height: 390 },
        { width: 568, height: 320 },
      ]) {
        await page.setViewportSize(viewport);
        await game.waitForAnimationFrames(3);
        const button = prompt.getByRole('button', { name: 'Tap to travel' });
        expect(await button.isVisible()).toBe(true);
        const travelBounds = await button.boundingBox();
        const boostBounds = await page.locator('#touch-boost').boundingBox();
        if (!travelBounds || !boostBounds) {
          throw new Error('Missing travel or Boost control bounds');
        }
        expect(travelBounds.y + travelBounds.height).toBeLessThan(boostBounds.y);
        await page.screenshot({
          path: screenshotManager.getScreenshotPath(`furnace-prompt-resized-${viewport.width}.png`),
        });
        if (viewport.width === 568) {
          const shotBefore = await page.evaluate(
            () => window.gameController?.getCurrPlayer()?.ship.lastShotTime
          );
          await button.focus();
          await page.keyboard.press('Space');
          expect(
            await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.lastShotTime)
          ).toBe(shotBefore);
        } else {
          await button.tap();
        }
        await menu.waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
      }
    }
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(new URL('/wiki/#controls', page.url()).href);
    await page
      .getByText('The mobile ability button keeps your equipped tool available over a furnace.', {
        exact: false,
      })
      .waitFor();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`mobile-controls-wiki-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  }, 30000);
}
