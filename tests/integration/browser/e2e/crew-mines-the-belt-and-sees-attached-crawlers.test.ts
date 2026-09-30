import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { beltSlotPosition } from '../../../../shared/asteroidBelt';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { withFixtureEvidence } from '../../utils/fixture-evidence';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();
function field(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(m => m.getSpiderField())"
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
]) {
  test(`a ${viewport.name} crew discovers the belt, sees shared crawlers and mines a deposit`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    await withFixtureEvidence(page, `belt-crew-${viewport.name}`, async (stage) => {
      const game = new GameInteractions(page);
      await game.bootGame({ waitForCombatReady: false });
      const home = beltSlotPosition(60);
      const second = await browserManager.createAdditionalPage({ hasTouch: viewport.hasTouch });
      await second.setViewportSize(viewport);
      const secondDiagnostics = watchBrowserDiagnostics(second);
      const crewmate = new GameInteractions(second);
      await crewmate.bootGame({ waitForCombatReady: false });
      await stage('crew-joined');
      const id = await game.getLocalPlayerId();
      const secondId = await crewmate.getLocalPlayerId();
      const epochs = await arrangeCrewField([id, secondId], 'belt-mining');
      await game.waitForControlledFixture(epochs.get(id));
      await crewmate.waitForControlledFixture(epochs.get(secondId));
      await stage('arranged');
      await expect
        .poll(
          async () =>
            (await field(page)).spiders.filter((s) => s.crawler?.hostId.includes('-60-')).length,
          {
            timeout: 10000,
          }
        )
        .toBeGreaterThan(0);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`asteroid-belt-${viewport.name}.png`),
      });
      const crawler = (await field(page)).spiders.find((s) => s.crawler?.hostId.includes('-60-'));
      expect(crawler?.crawler).toBeDefined();
      if (!crawler?.crawler) {
        throw new Error('Belt host has no crawlers');
      }
      await page.locator('#universe-map-toggle').click();
      await expect
        .poll(async () => (await field(second)).spiders.some((s) => s.id === crawler.id))
        .toBe(true);
      await stage('shared-crawlers');
      // Discover the actual belt through the server, then inspect the shared map.
      await expect
        .poll(() => page.locator('#universe-map-locations').textContent())
        .toContain('Asteroid belt');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`asteroid-belt-map-${viewport.name}.png`),
      });
      await page.locator('#universe-map-close').click();
      const hostId = crawler.crawler.hostId;
      const health = await page.evaluate(
        (asteroidId) =>
          window.gameController
            ?.getCurrRoidBelt()
            .getRoids()
            .find((r) => r.id === asteroidId)?.health,
        hostId
      );
      expect(health).toBeGreaterThan(0);
      await game.placeControlledShipAt(home.x - 300, home.y + 90);
      await stage('mining-request');
      await game.fireLaserToward(home.x, home.y);
      await expect
        .poll(
          async () =>
            page.evaluate(
              (asteroidId) =>
                window.gameController
                  ?.getCurrRoidBelt()
                  .getRoids()
                  .find((r) => r.id === asteroidId)?.health ?? 0,
              hostId
            ),
          { timeout: 5000 }
        )
        .toBeLessThan(health ?? 0);
      await game.placeControlledShipAt(home.x - 450, home.y);
      await stage('mined-and-safe');
      assertNoBrowserDiagnostics(diagnostics);
      assertNoBrowserDiagnostics(secondDiagnostics);
    });
  }, 45000);
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
]) {
  test(`a ${viewport.name} pilot sees a belt crawler wind up before its strike`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    await withFixtureEvidence(page, `belt-windup-${viewport.name}`, async (stage) => {
      const game = new GameInteractions(page);
      await game.bootGame({ waitForCombatReady: false });
      const id = await game.getLocalPlayerId();
      const epochs = await arrangeCrewField([id], 'belt-mining');
      await game.waitForControlledFixture(epochs.get(id));
      const home = beltSlotPosition(60);
      await expect.poll(async () => (await field(page)).spiders.length).toBeGreaterThan(0);
      const crawler = (await field(page)).spiders.find((spider) =>
        spider.crawler?.hostId.includes('-60-')
      );
      if (!crawler?.crawler) {
        throw new Error('Explicit belt host has no crawler');
      }
      await stage('windup-request');
      // Approach the exposed side and prove that the visible crouch precedes a strike.
      const near = (await field(page)).spiders
        .filter((spider) => spider.crawler?.hostId === crawler.crawler?.hostId)
        .sort((a, b) => a.position.x - b.position.x)[0];
      if (!near) {
        throw new Error('No exposed belt crawler');
      }
      const outward = Math.atan2(near.position.y - home.y, near.position.x - home.x);
      await game.placeControlledShipAt(
        near.position.x + Math.cos(outward) * 50,
        near.position.y + Math.sin(outward) * 50
      );
      await expect
        .poll(
          async () =>
            (await field(page)).spiders.some(
              (spider) =>
                spider.crawler?.hostId === crawler.crawler?.hostId &&
                spider.crawler?.phase === 'winding'
            ),
          { timeout: 4000, interval: 20 }
        )
        .toBe(true);

      await game.placeControlledShipAt(home.x - 250, home.y);
      await stage('winding-observed-and-safe');
      assertNoBrowserDiagnostics(diagnostics);
    });
  }, 30000);
}
