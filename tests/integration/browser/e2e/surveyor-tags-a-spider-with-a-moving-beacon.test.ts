import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { TOWN_HEARTH } from '../../../../shared/furnaces';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
function field(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
  );
}
for (const width of [1280, 390]) {
  test(`a Surveyor tags a moving spider and reads the tool rules at ${width}px`, async () => {
    const mobile = width === 390;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'surveyor', waitForCombatReady: false });
    if (mobile) {
      await page.locator('#ship-schematic-toggle').tap();
    } else {
      await page.keyboard.press('v');
    }
    await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
    const card = page.locator('[data-utility-id="survey_probe"]');
    if (mobile) {
      await card.tap();
    } else {
      await card.click();
    }
    await page.getByRole('button', { name: 'Return to flight' }).click();
    const id = await game.getLocalPlayerId();
    const works = TOWN_HEARTH;
    await arrangeCrewField([id], 'spider-tools');
    await game.placeShipAt(works.position.x + 400, works.position.y);
    await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Missing Surveyor');
      }
      ship.angle = 0;
      ship.angularVelocity = 0;
    });
    await page.mouse.move(width * 0.9, (mobile ? 844 : 900) / 2);
    await page.waitForFunction(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      return ship && Math.abs(Math.sin(ship.angle)) < 0.03 && Math.cos(ship.angle) > 0;
    });
    await game.waitForAnimationFrames(4);
    await expect.poll(async () => (await field(page)).spiders.length).toBe(1);
    const target = (await field(page)).spiders[0];
    if (!target) {
      throw new Error('Missing spider');
    }
    if (mobile) {
      await page.locator('#touch-ability').tap();
    } else {
      await page.keyboard.press('e');
    }
    await expect
      .poll(
        async () =>
          (await field(page)).spiders.find((spider) => spider.id === target.id)?.probe?.ownerId
      )
      .toBe(id);
    const tagged = (await field(page)).spiders.find((spider) => spider.id === target.id);
    if (!tagged?.probe) {
      throw new Error('Probe was not attached');
    }
    await expect
      .poll(async () => {
        const moved = (await field(page)).spiders.find((spider) => spider.id === target.id);
        return moved
          ? Math.hypot(moved.position.x - tagged.position.x, moved.position.y - tagged.position.y)
          : 0;
      })
      .toBeGreaterThan(5);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-probe-${width}.png`),
    });
    for (const route of ['hauler', 'surveyor', 'terrain']) {
      await page.goto(new URL(`/wiki/#${route}`, page.url()).href);
      const heading = page
        .getByRole('heading', {
          name:
            route === 'hauler' ? 'Hauler' : route === 'surveyor' ? 'Surveyor' : 'Terrain spiders',
          exact: true,
        })
        .first();
      await heading.waitFor();
      const changedText = page
        .locator('p')
        .filter({
          hasText:
            route === 'hauler'
              ? 'Tapping a spider extracts'
              : route === 'surveyor'
                ? 'Attach a probe to a guarding spider'
                : "Hauler's Resource Tap extracts collectible silk",
        })
        .first();
      await changedText.waitFor();
      await changedText.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' })
      );
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`spider-wiki-${route}-${width}.png`),
      });
    }
    assertNoBrowserDiagnostics(diagnostics);
  }, 45000);
}
