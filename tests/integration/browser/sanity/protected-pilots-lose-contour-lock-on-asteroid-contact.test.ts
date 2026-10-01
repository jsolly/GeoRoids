// @vitest-environment node
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
  { name: 'desktop', width: 1280, height: 900, touch: false },
  { name: 'mobile', width: 390, height: 844, touch: true },
]) {
  test(`a protected ${viewport.name} pilot loses Contour Lock on asteroid contact through later snapshots`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    const observerPage = await browserManager.createAdditionalPage();
    const observerDiagnostics = watchBrowserDiagnostics(observerPage);
    const observer = new GameInteractions(observerPage);
    await observer.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId, await observer.getLocalPlayerId()], 'tow');
    // The existing tow fixture places a stationary rock at (0, -260) and
    // arms server-owned protection. This approach follows its intersecting rail.
    await game.placeShipAt(180, -215);
    await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Missing collision pilot');
      }
      ship.angle = Math.PI;
      ship.angularVelocity = 0;
    });
    await game.waitForServerSpawnProtection();
    const health = await game.getShipHealth();
    const button = page.locator('#touch-contour-lock');
    await expect.poll(() => button.isEnabled()).toBe(true);
    if (viewport.touch) {
      await button.tap();
    } else {
      await page.keyboard.press('ShiftLeft');
    }
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
    const remoteLocked = () =>
      observerPage.evaluate((id) => {
        const ship = window.gameController
          ?.getNetworkManager()
          .getAllPlayers()
          .find((player) => player.id === id)?.ship;
        return ship ? Boolean(ship.contourLock) : null;
      }, playerId);
    await expect.poll(remoteLocked).toBe(true);

    const impact = await page.evaluate(async () => {
      let closest = Infinity;
      for (let frame = 0; frame < 240; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const ship = window.gameController?.getCurrPlayer()?.ship;
        const rock = window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .find((candidate) => candidate.id === 'crew-fixture-ore');
        if (!ship || !rock) {
          throw new Error('Missing protected collision participants');
        }
        closest = Math.min(
          closest,
          Math.hypot(ship.position.x - rock.position.x, ship.position.y - rock.position.y)
        );
        if (!ship.contourLocked) {
          return {
            closest,
            contactRadius: ship.r + rock.r,
            protected: ship.spawnProtectionTimer > 0 || ship.blinkCount > 0,
            health: ship.health,
          };
        }
      }
      throw new Error('The protected asteroid contact never released Contour Lock');
    });
    expect(impact.closest).toBeLessThanOrEqual(impact.contactRadius);
    expect(impact.protected).toBe(true);
    expect(impact.health).toBe(health);
    await expect.poll(remoteLocked).toBe(false);
    const relocked = await page.evaluate(async () => {
      for (let frame = 0; frame < 90; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (window.gameController?.getCurrPlayer()?.ship.contourLocked) {
          return true;
        }
      }
      return false;
    });
    expect(relocked).toBe(false);
    expect(await remoteLocked()).toBe(false);
    expect(await game.getShipHealth()).toBe(health);
    expect(await button.getAttribute('aria-pressed')).toBe('false');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(
        `protected-contact-releases-lock-${viewport.name}.png`
      ),
    });
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(observerDiagnostics);
  }, 20000);
}
