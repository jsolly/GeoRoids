import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
const FIXTURE_ASTEROID_ID = 'crew-fixture-ore';

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])(
  'Hauler E attaches and releases one persistent tow cable at $width pixels',
  async (viewport) => {
    const mobile = viewport.width < 600;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    const useAbility = () =>
      mobile ? page.locator('#touch-ability').tap() : page.keyboard.press('KeyE');
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'delivery');
    await page.waitForFunction(
      (asteroidId) => {
        const controller = window.gameController;
        const asteroid = controller
          ?.getCurrRoidBelt()
          .getRoids()
          .find((rock) => rock.id === asteroidId);
        return controller?.getCurrPlayer()?.ship.kitId === 'hauler' && asteroid?.health === 75;
      },
      FIXTURE_ASTEROID_ID,
      { timeout: 5000, polling: 50 }
    );

    const canvas = await page.locator('#gameCanvas').boundingBox();
    if (!canvas) {
      throw new Error('Game canvas unavailable');
    }
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height * 0.12);
    await useAbility();
    await expect
      .poll(
        () => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId),
        { timeout: 5000, message: 'Hauler E should attach the fixture asteroid' }
      )
      .toBe(FIXTURE_ASTEROID_ID);

    const atAttach = await page.evaluate((asteroidId) => {
      const asteroid = window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .find((rock) => rock.id === asteroidId);
      if (!asteroid) {
        throw new Error('Tow fixture disappeared at attachment');
      }
      return { x: asteroid.position.x, y: asteroid.position.y };
    }, FIXTURE_ASTEROID_ID);

    // Attachment preserves the rock's momentum. Turn away from it so the
    // persistent cable becomes taut before checking that towing moves cargo.
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height * 0.88);
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ asteroidId, beforeY }) => {
              const controller = window.gameController;
              const ship = controller?.getCurrPlayer()?.ship;
              const asteroid = controller
                ?.getCurrRoidBelt()
                .getRoids()
                .find((rock) => rock.id === asteroidId);
              return (
                ship?.harpoonTargetId === asteroidId &&
                asteroid !== undefined &&
                Math.abs(asteroid.position.y - beforeY) > 0.5
              );
            },
            { asteroidId: FIXTURE_ASTEROID_ID, beforeY: atAttach.y }
          ),
        {
          timeout: 5000,
          message: 'The taut tow cable should move the attached rock with the Hauler',
        }
      )
      .toBe(true);
    const duringTow = await page.evaluate((asteroidId) => {
      const controller = window.gameController;
      const ship = controller?.getCurrPlayer()?.ship;
      const asteroid = controller
        ?.getCurrRoidBelt()
        .getRoids()
        .find((rock) => rock.id === asteroidId);
      if (!ship || !asteroid) {
        throw new Error('Tow fixture disappeared before release');
      }
      return {
        towId: ship.harpoonTargetId,
        asteroid: { x: asteroid.position.x, y: asteroid.position.y },
        hasRemovedTimer: 'harpoonTimer' in ship,
      };
    }, FIXTURE_ASTEROID_ID);
    expect(duringTow.towId).toBe(FIXTURE_ASTEROID_ID);
    expect(duringTow.hasRemovedTimer).toBe(false);
    if (mobile) {
      expect(await page.locator('#touch-ability').textContent()).toBe('RELEASE');
      expect(await page.locator('#touch-ability').getAttribute('aria-disabled')).toBe('false');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath('hauler-release-mobile.png'),
      });
    }
    expect(duringTow.asteroid.y).not.toBe(atAttach.y);

    await useAbility();
    await expect
      .poll(
        () => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId),
        {
          timeout: 5000,
          message: 'Hauler E should release the tow cable',
        }
      )
      .toBeNull();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`hauler-tow-${viewport.width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
