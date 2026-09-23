import { expect, test } from 'vitest';
import { civicLot } from '../../../../shared/furnaces';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();
for (const width of [1280, 390]) {
  test(`a chased Scout lights a refuge and the living spider flees at ${width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: width === 390 });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    const id = await game.getLocalPlayerId();
    const lot = civicLot('street-1-0');
    if (!lot) {
      throw new Error('Missing escape foundation');
    }
    await arrangeCrewField([id], 'street-escape');
    const field = (): Promise<SpiderFieldState> =>
      page.evaluate(
        "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
      );
    await expect
      .poll(async () => (await field()).spiders.some((spider) => spider.targetId === id))
      .toBe(true);
    const hunter = (await field()).spiders.find((spider) => spider.targetId === id);
    if (!hunter) {
      throw new Error('No active hunter');
    }
    if (width === 390) {
      await page.locator('#touch-ability').tap();
    } else {
      await page.keyboard.press('KeyE');
    }
    await expect
      .poll(
        () =>
          page.evaluate(
            "import('/src/network/worldExploration.ts').then(({worldFurnaces}) => worldFurnaces.isLit('street-1-0'))"
          ),
        { timeout: 5000 }
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await field()).spiders.find((spider) => spider.id === hunter.id)?.targetId ?? null
      )
      .toBeNull();
    await expect
      .poll(
        async () => {
          const spider = (await field()).spiders.find((candidate) => candidate.id === hunter.id);
          return spider
            ? Math.hypot(spider.position.x - lot.position.x, spider.position.y - lot.position.y)
            : 0;
        },
        { timeout: 8000 }
      )
      .toBeGreaterThan(300);
    expect(
      await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.health ?? 0)
    ).toBeGreaterThan(0);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`furnace-escape-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  }, 30000);
}
