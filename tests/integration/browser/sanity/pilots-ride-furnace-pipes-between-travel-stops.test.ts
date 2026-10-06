// @vitest-environment node
import { expect, test } from 'vitest';
import { civicLot } from '../../../../shared/furnaces';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { withFixtureEvidence } from '../../utils/fixture-evidence';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField, getFixtureState } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const width of [1280, 390]) {
  test(`a pilot rides their ship from a built furnace to Town Square and back at ${width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: width === 390 });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    await withFixtureEvidence(page, `furnace-roundtrip-${width}`, async (stage) => {
      const game = new GameInteractions(page);
      await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
      const lot = civicLot('street-1-0');
      if (!lot) {
        throw new Error('Missing street travel fixture');
      }
      const id = await game.getLocalPlayerId();
      await stage('join-complete');
      const epochs = await arrangeCrewField([id], 'street-travel');
      await game.waitForControlledFixture(epochs.get(id));
      await stage('arranged');
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
      await expect
        .poll(() => prompt.locator(width === 390 ? 'button' : 'span').textContent())
        .toBe(width === 390 ? 'Tap to travel' : 'Press E to travel');
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
      expect(rotation).toBe(0);
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
      await stage('outbound-request');
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
      const transitRotation = await page.evaluate<number>(
        `import('/src/rendering/canvasSurface.ts').then(({canvasManager}) => {
        const ship = window.gameController.getCurrPlayer().ship;
        if (!ship.furnaceTransit) throw new Error('Missing active pipe ride');
        return canvasManager.getCameraRotation();
      })`
      );
      expect(transitRotation).toBe(0);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`rocket-pipe-ride-${width}.png`),
      });
      await page.waitForFunction(() => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        return ship && !ship.furnaceTransit && Math.hypot(ship.position.x, ship.position.y) < 220;
      });
      await stage('town-arrival');
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
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`town-entry-${width}.png`),
      });
      await townMenu.getByRole('button', { name: 'Fast Travel', exact: true }).click();
      await menu.waitFor({ state: 'visible' });
      expect(await menu.locator('#town-store-offer').isVisible()).toBe(false);
      const back = menu.locator('[data-furnace-id="street-1-0"]');
      expect(await back.isEnabled()).toBe(true);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`town-travel-and-lives-${width}.png`),
      });
      await stage('return-request');
      await back.click();
      await page.waitForFunction(({ x, y }) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        return (
          ship && !ship.furnaceTransit && Math.hypot(ship.position.x - x, ship.position.y - y) < 220
        );
      }, lot.position);
      await stage('furnace-arrival');
      await game.placeControlledShipAt(lot.position.x + lot.radius + 10, lot.position.y);
      await prompt.waitFor({ state: 'hidden' });
      expect(await page.locator('#touch-ability').textContent()).not.toContain('TRAVEL');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`outside-furnace-footprint-${width}.png`),
      });
      await game.placeControlledShipAt(lot.position.x, lot.position.y);
      await prompt.waitFor({ state: 'visible' });
      assertNoBrowserDiagnostics(diagnostics);
    });
  }, 30000);
}

for (const width of [1280, 390]) {
  test(`a pilot buys paint from Town Square and returns to its menu at ${width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: width === 390 });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    const id = await game.getLocalPlayerId();
    const epochs = await arrangeCrewField([id], 'town-store');
    await game.waitForControlledFixture(epochs.get(id));
    await page.keyboard.press('KeyE');
    const townMenu = page.getByRole('dialog', { name: 'Town Square', exact: true });
    await townMenu.waitFor({ state: 'visible' });
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
    await townMenu.waitFor({ state: 'visible' });
    assertNoBrowserDiagnostics(diagnostics);
  }, 30000);
}

test('the touch furnace prompt fits resized viewports and keeps Space from firing', async () => {
  const page = await browserManager.recreatePage({ hasTouch: true });
  const diagnostics = watchBrowserDiagnostics(page);
  await withFixtureEvidence(page, 'furnace-prompt-resized', async (stage) => {
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    const id = await game.getLocalPlayerId();
    const lot = civicLot('street-1-0');
    if (!lot) {
      throw new Error('Missing street travel fixture');
    }
    await stage('join-complete');
    // This scenario tests layout and native button activation, not flight. Keep
    // cruise acceleration at zero while real input and network updates continue.
    const originalThrust = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship || ship.health <= 0 || ship.exploding) {
        throw new Error('Live fixture ship unavailable');
      }
      const thrust = ship.thrust;
      ship.thrust = 0;
      return thrust;
    });
    const failures: unknown[] = [];
    try {
      const epochs = await arrangeCrewField([id], 'street-travel');
      await game.waitForControlledFixture(epochs.get(id));
      const assertStationary = async () => {
        await game.waitForControlledFixture(epochs.get(id));
        const server = (await getFixtureState()).players.find((pilot) => pilot.id === id);
        expect(server?.position).toEqual(lot.position);
        expect(server?.velocity).toEqual({ x: 0, y: 0 });
        const client = await page.evaluate(() => {
          const ship = window.gameController?.getCurrPlayer()?.ship;
          return { position: ship?.position, velocity: ship?.velocity, thrust: ship?.thrust };
        });
        expect(client.position).toEqual(lot.position);
        expect(client.thrust).toBe(0);
        if (!client.velocity) {
          throw new Error('Stationary fixture velocity unavailable');
        }
        expect(Math.hypot(client.velocity.x, client.velocity.y)).toBe(0);
      };
      await assertStationary();
      await stage('stationary-arranged');
      await page.keyboard.press('KeyE');
      const prompt = page.locator('#furnace-travel-prompt');
      await prompt.waitFor({ state: 'visible' });
      const menu = page.getByRole('dialog', { name: 'Furnace travel' });
      await stage('furnace-lit-prompt-active');
      for (const viewport of [
        { width: 320, height: 568 },
        { width: 844, height: 390 },
        { width: 568, height: 320 },
      ]) {
        await stage(`viewport-${viewport.width}-resize-request`);
        await page.setViewportSize(viewport);
        await game.waitForAnimationFrames(3);
        const button = prompt.getByRole('button', { name: 'Tap to travel' });
        expect(await button.isVisible()).toBe(true);
        expect(await prompt.evaluate((element) => element.classList.contains('is-visible'))).toBe(
          true
        );
        await assertStationary();
        const travelBounds = await button.boundingBox();
        const contourLockBounds = await page.locator('#touch-contour-lock').boundingBox();
        if (!travelBounds || !contourLockBounds) {
          throw new Error('Missing travel or Contour Lock control bounds');
        }
        expect(travelBounds.y + travelBounds.height).toBeLessThan(contourLockBounds.y);
        await page.screenshot({
          path: screenshotManager.getScreenshotPath(`furnace-prompt-resized-${viewport.width}.png`),
        });
        await stage(`viewport-${viewport.width}-layout-captured`);
        if (viewport.width === 568) {
          const shotBefore = await page.evaluate(
            () => window.gameController?.getCurrPlayer()?.ship.lastShotTime
          );
          await button.focus();
          expect(await button.evaluate((element) => document.activeElement === element)).toBe(true);
          await stage('viewport-568-space-focused');
          await page.keyboard.press('Space');
          expect(
            await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.lastShotTime)
          ).toBe(shotBefore);
        } else {
          await button.tap();
        }
        await stage(`viewport-${viewport.width}-activation-sent`);
        await menu.waitFor({ state: 'visible' });
        await stage(`viewport-${viewport.width}-menu-visible`);
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        await assertStationary();
        await stage(`viewport-${viewport.width}-menu-closed-stationary`);
      }
      assertNoBrowserDiagnostics(diagnostics);
    } catch (error) {
      failures.push(error);
    }
    try {
      await page.evaluate((thrust) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        if (!ship) {
          throw new Error('Fixture ship unavailable during thrust restoration');
        }
        ship.thrust = thrust;
      }, originalThrust);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Furnace prompt fixture and restoration failed');
    }
  });
}, 30000);

for (const width of [1280, 390]) {
  test(`the controls Wiki explains mobile furnace ability access at ${width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: width === 390 });
    const diagnostics = watchBrowserDiagnostics(page);
    await page.goto(new URL('/wiki/#controls', TestConfig.GAME_URL).href);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page
      .getByText('The mobile ability button keeps your equipped tool available over a furnace.', {
        exact: false,
      })
      .waitFor();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`mobile-controls-wiki-${width}.png`),
    });
    expect(
      await page
        .getByText('The mobile ability button keeps your equipped tool available over a furnace.', {
          exact: false,
        })
        .isVisible()
    ).toBe(true);
    assertNoBrowserDiagnostics(diagnostics);
  }, 30000);
}
