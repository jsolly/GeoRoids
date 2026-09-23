import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
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
  test(`a ${viewport.name} miner sees a black spider escape its broken rock and kills it directly`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await arrangeCrewField([await game.getLocalPlayerId()], 'belt-escape');
    await game.placeShipAt(-160, -620);
    await game.armSpawnProtection();
    await expect
      .poll(async () => (await field(page)).spiders.filter((s) => s.crawler).length)
      .toBe(1);
    const original = (await field(page)).spiders.find((s) => s.crawler);
    if (!original) {
      throw new Error('Fixture crawler missing');
    }
    await game.fireLaserToward(0, -620);
    await game.placeShipAt(80, -460);
    await game.armSpawnProtection();
    await expect
      .poll(
        async () => (await field(page)).spiders.find((s) => s.id === original.id)?.crawler?.phase,
        { timeout: 3000, interval: 10 }
      )
      .toBe('escaping');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`asteroid-belt-escape-${viewport.name}.png`),
    });
    await expect
      .poll(
        async () => (await field(page)).spiders.find((s) => s.id === original.id)?.crawler?.phase,
        { timeout: 5000 }
      )
      .toBe('crawling');
    const survivor = (await field(page)).spiders.find((s) => s.id === original.id);
    expect(survivor?.crawler?.hostId).toBe('crew-fixture-escape-destination');
    expect(survivor?.health).toBe(original.health);
    expect((await game.getAsteroidPositions()).some((r) => r.id === 'belt-1-0-0')).toBe(false);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`asteroid-belt-black-${viewport.name}.png`),
    });
    for (let shot = 0; shot < 8; shot++) {
      const target = (await field(page)).spiders.find((s) => s.id === original.id);
      if (!target) {
        break;
      }
      const angle = Math.atan2(target.position.y + 620, target.position.x - 180);
      await game.placeShipAt(
        target.position.x + Math.cos(angle) * 90,
        target.position.y + Math.sin(angle) * 90
      );
      await game.armSpawnProtection();
      const liveTarget = (await field(page)).spiders.find((s) => s.id === original.id);
      if (!liveTarget) {
        break;
      }
      await game.fireLaserToward(liveTarget.position.x, liveTarget.position.y);
      await page.waitForTimeout(400);
    }
    await expect
      .poll(async () => (await field(page)).spiders.some((s) => s.id === original.id))
      .toBe(false);
    const hostHealth = await page.evaluate(
      () =>
        window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .find((r) => r.id === 'crew-fixture-escape-destination')?.health
    );
    expect(hostHealth).toBe(150);
    assertNoBrowserDiagnostics(diagnostics);
  }, 30000);
}
