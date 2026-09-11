import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([1280, 390])(
  'Warden projects a shield onto a nearby teammate without precise aim at %i pixels',
  async (width) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Warden page unavailable');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height: 900 });
    const warden = new GameInteractions(page);
    await warden.bootGame({ kitId: 'warden', waitForCombatReady: false });
    await warden.placeShipAt(-1700, 0);
    const faction = await page.evaluate(() => window.gameController?.getCurrPlayer()?.factionId);
    const teammates = [];
    for (let index = 0; index < 2; index++) {
      const otherPage = await browserManager.createAdditionalPage();
      const game = new GameInteractions(otherPage);
      await game.bootGame({ kitId: 'dart', waitForCombatReady: false });
      await game.placeShipAt(-1900, 400 + index * 150);
      const otherFaction = await otherPage.evaluate(
        () => window.gameController?.getCurrPlayer()?.factionId
      );
      teammates.push({ page: otherPage, game, friendly: otherFaction === faction });
    }
    const friend = teammates.find((entry) => entry.friendly);
    const enemy = teammates.find((entry) => !entry.friendly);
    if (!friend || !enemy) {
      throw new Error('Balanced factions must provide one friendly and one hostile pilot');
    }
    await friend.game.waitForCombatReady();
    await friend.game.placeShipAt(-1580, 80);
    await enemy.game.placeShipAt(-1850, 0);
    await warden.waitForRemoteHumanPlayers(2);
    await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Warden unavailable');
      }
      ship.angle = Math.PI;
    });
    const wardenId = await warden.getLocalPlayerId();
    await expect
      .poll(() =>
        friend.page.evaluate(
          (id) =>
            window.gameController
              ?.getNetworkManager()
              .getAllPlayers()
              .find((pilot) => pilot.id === id)?.ship.angle,
          wardenId
        )
      )
      .toBeCloseTo(Math.PI, 2);
    await page.keyboard.press('KeyE');
    await expect
      .poll(() =>
        friend.page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.shieldTimer ?? 0)
      )
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.shieldTimer)
    ).toBe(0);
    expect(
      await enemy.page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.shieldTimer)
    ).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.abilityCooldownFrames ?? 0)
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.shieldTargetId))
      .toBe(await friend.game.getLocalPlayerId());
    await expect
      .poll(() =>
        friend.page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.shieldSourceId)
      )
      .toBe(await warden.getLocalPlayerId());
    // Let the next frame paint the synchronized recipient shield and link.
    await warden.waitForAnimationFrames(2);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`warden-friendly-projection-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
