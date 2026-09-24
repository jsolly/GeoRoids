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
  test(`a ${viewport.name} crew is pursued across intact rocks and sees a longer attack lunge`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    const teammatePage = await browserManager.createAdditionalPage();
    const teammateDiagnostics = watchBrowserDiagnostics(teammatePage);
    const teammate = new GameInteractions(teammatePage);
    await teammate.bootGame({ waitForCombatReady: false });
    await arrangeCrewField(
      [await game.getLocalPlayerId(), await teammate.getLocalPlayerId()],
      'belt-pursuit'
    );
    await game.placeShipAt(620, -620);
    await page.locator('#universe-map-toggle').click();
    await teammate.placeShipAt(640, -420);
    await teammatePage.locator('#universe-map-toggle').click();
    const visited = new Set<string>();
    const id = 'belt-crawler:belt-1-0-0:0';
    await expect
      .poll(
        async () => {
          const crawler = (await field(page)).spiders.find((s) => s.id === id);
          if (crawler?.crawler) {
            visited.add(crawler.crawler.hostId);
          }
          return crawler?.crawler?.hostId;
        },
        { timeout: 20000, interval: 25 }
      )
      .toBe('crew-fixture-pursuit-destination');
    expect(visited.has('crew-fixture-escape-destination')).toBe(true);
    await expect
      .poll(
        async () => (await field(teammatePage)).spiders.find((s) => s.id === id)?.crawler?.hostId
      )
      .toBe('crew-fixture-pursuit-destination');
    const rocks = await game.getAsteroidPositions();
    expect(rocks.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'belt-1-0-0',
        'crew-fixture-escape-destination',
        'crew-fixture-pursuit-destination',
      ])
    );
    await page.locator('#universe-map-close').click();
    if (viewport.hasTouch) {
      await game.placeShipAt(440, -620);
    }
    await game.armSpawnProtection();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`asteroid-belt-pursuit-${viewport.name}.png`),
    });
    await expect
      .poll(async () => (await field(page)).spiders.find((s) => s.id === id)?.crawler?.phase, {
        timeout: 5000,
      })
      .not.toBe('escaping');
    // Hold beyond the old attack range while the hunter rounds its final rock.
    await game.placeShipAt(535, -620);
    await page.locator('#universe-map-toggle').click();
    await game.armSpawnProtection();
    await expect
      .poll(async () => (await field(page)).spiders.find((s) => s.id === id)?.crawler?.phase, {
        timeout: 5000,
        interval: 15,
      })
      .toBe('lunging');
    await page.locator('#universe-map-close').click();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`asteroid-belt-long-lunge-${viewport.name}.png`),
    });
    expect((await field(page)).spiders.filter((s) => s.crawler)).toHaveLength(1);
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(teammateDiagnostics);
  }, 40000);
}
