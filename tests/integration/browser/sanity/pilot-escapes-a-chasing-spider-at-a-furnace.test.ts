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
    "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
  );
}

for (const width of [1280, 390]) {
  test(`a pilot escapes a chasing spider at Town Square at ${width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: width === 390 });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    const id = await game.getLocalPlayerId();
    await arrangeCrewField([id], 'spider-tools');
    await expect.poll(async () => (await field(page)).spiders[0]?.targetId).toBe(id);
    const chasing = (await field(page)).spiders[0];
    if (!chasing) {
      throw new Error('Missing chasing spider');
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-chasing-${width}.png`),
    });
    await game.placeShipAt(690, 0);
    await expect.poll(async () => (await field(page)).spiders[0]?.targetId).toBeNull();
    const retreat = (await field(page)).spiders[0];
    if (!retreat) {
      throw new Error('Spider disappeared instead of retreating');
    }
    expect(retreat.phase).toBe('scuttling');
    // The pursuer approached from the east; shelter must turn it eastward again.
    expect(Math.cos(retreat.angle)).toBeGreaterThan(0);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-retreat-${width}.png`),
    });
    await page.goto(`${new URL(page.url()).origin}/wiki/#terrain`);
    const heading = page.getByRole('heading', { name: 'Terrain spiders', exact: true });
    await heading.waitFor();
    await heading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-safety-wiki-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  }, 60_000);
}
