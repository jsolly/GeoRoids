import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField, placePlayer } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
function field(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(m => m.getSpiderField())"
  );
}

for (const width of [1280, 390]) {
  for (const victim of ['passer', 'hauler'] as const) {
    test(`a towed spider bites the ${victim} within reach at ${width}px`, async () => {
      const page = await browserManager.recreatePage({ hasTouch: width === 390 });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const diagnostics = watchBrowserDiagnostics(page);
      const game = new GameInteractions(page);
      await game.bootGame({
        kitId: 'hauler',
        haulerUtility: 'tow_cable',
        waitForCombatReady: false,
      });
      const otherPage = await browserManager.createAdditionalPage();
      const otherDiagnostics = watchBrowserDiagnostics(otherPage);
      const other = new GameInteractions(otherPage);
      await other.bootGame({ waitForCombatReady: false });
      const ownerId = await game.getLocalPlayerId();
      const passerId = await other.getLocalPlayerId();
      await arrangeCrewField([ownerId, passerId], 'spider-tow-bite');
      await expect.poll(async () => (await field(page)).spiders.length).toBe(1);
      const captive = (await field(page)).spiders[0];
      if (!captive) {
        throw new Error('Missing captive');
      }
      if (width === 390) {
        await page.locator('#touch-ability').tap();
      } else {
        await page.keyboard.press('e');
      }
      const latch = () =>
        page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId);
      await expect.poll(latch).toBe(captive.id);
      await expect
        .poll(() =>
          otherPage.evaluate(
            (id) =>
              window.gameController
                ?.getPlayerManager()
                .getNonLocalPlayers()
                .find((p) => p.id === id)?.ship.harpoonTargetId,
            ownerId
          )
        )
        .toBe(captive.id);
      const target = victim === 'hauler' ? game : other;
      const targetId = victim === 'hauler' ? ownerId : passerId;
      const targetPage = victim === 'hauler' ? page : otherPage;
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`towed-spider-before-${victim}-${width}.png`),
      });
      const live = (await field(page)).spiders.find((s) => s.id === captive.id);
      if (!live) {
        throw new Error('Captive disappeared');
      }
      // Put the real connected ship into reach; server combat must produce and broadcast the bite.
      await placePlayer(targetId, live.position);
      await expect
        .poll(
          () => targetPage.evaluate(() => window.gameController?.getCurrPlayer()?.ship.health),
          { interval: 25 }
        )
        .toBe(0);
      const witness = victim === 'hauler' ? otherPage : page;
      await expect
        .poll(() =>
          witness.evaluate(
            (id) =>
              window.gameController
                ?.getPlayerManager()
                .getNonLocalPlayers()
                .find((p) => p.id === id)?.ship.health,
            targetId
          )
        )
        .toBe(0);
      if (victim === 'passer') {
        expect(await latch()).toBe(captive.id);
      }
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`towed-spider-bite-${victim}-${width}.png`),
      });
      await target.waitForShipAlive(25000);
      expect(await target.isGameRunning()).toBe(true);
      await page.goto(`${TestConfig.GAME_URL}/wiki/#hauler`);
      const rule = page.locator('p').filter({ hasText: 'A towed spider can still bite' });
      await rule.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`towed-spider-wiki-${victim}-${width}.png`),
      });
      assertNoBrowserDiagnostics(diagnostics);
      assertNoBrowserDiagnostics(otherDiagnostics);
    }, 45000);
  }
}
