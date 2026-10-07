// @vitest-environment node
import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import type { SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { withFixtureEvidence } from '../../utils/fixture-evidence';
import { GameInteractions } from '../../utils/game-interactions';
import { observeRenderedTow } from '../../utils/rendered-tow-observation';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

function field(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
  );
}

for (const width of [1280, 390]) {
  test(`a spider bites through a Hauler's cable to free its companion at ${width}px`, async () => {
    const mobile = width === 390;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'hauler', haulerUtility: 'tow_cable', waitForCombatReady: false });
    const id = await game.getLocalPlayerId();
    // Load observation code and provenance before the moving encounter starts.
    await page.evaluate("import('/tests/support/towLifecycle.ts').then(() => undefined)");
    let observation: Awaited<ReturnType<typeof observeRenderedTow>> | undefined;
    const failures: unknown[] = [];
    try {
      await withFixtureEvidence(
        page,
        `spider-rescue-${width}`,
        async (stage) => {
          const epochs = await arrangeCrewField([id], 'spider-rescue');
          await game.waitForControlledFixture(epochs.get(id));
          await expect.poll(async () => (await field(page)).spiders.length).toBe(2);
          const spiders = (await field(page)).spiders.sort((a, b) => a.position.y - b.position.y);
          const captive = spiders[0];
          const rescuer = spiders[1];
          if (!captive || !rescuer) {
            throw new Error('Expected captive and rescuer');
          }
          const latch = () =>
            page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId);
          const epoch = epochs.get(id);
          if (epoch === undefined) {
            throw new Error('Rescue fixture omitted its epoch');
          }
          observation = await observeRenderedTow(page, {
            pilotId: id,
            targetId: captive.id,
            epoch,
          });
          const activeObservation = observation;
          const target = (await field(page)).spiders.find((spider) => spider.id === captive.id);
          if (!target || target.health <= 0) {
            throw new Error('Rescue captive disappeared before launch');
          }
          await game.aimAtWorldPosition(target.position);
          // The scene is already moving: capture evidence after ordinary input.
          if (mobile) {
            await page.locator('#touch-ability').tap();
          } else {
            await page.keyboard.press('e');
          }
          await expect
            .poll(() => activeObservation.evaluate((observer) => observer.read().attached), {
              timeout: 5000,
            })
            .not.toBeNull();
          await expect
            .poll(() => activeObservation.evaluate((observer) => observer.read().released), {
              timeout: 15000,
            })
            .not.toBeNull();
          // Inspect only after release: the driver's delay cannot erase the draw.
          const retained = await activeObservation.evaluate((observer) => observer.read());
          expect(retained.attached?.targetId).toBe(captive.id);
          expect(retained.released?.targetId).toBeNull();
          await expect.poll(latch).toBeNull();
          const image = await activeObservation.evaluate((observer) => observer.image());
          if (!image?.startsWith('data:image/png;base64,')) {
            throw new Error('Missing rendered cable attachment');
          }
          const freed = (await field(page)).spiders.find((spider) => spider.id === captive.id);
          expect(freed?.health).toBeGreaterThan(0);
          const helper = (await field(page)).spiders.find((spider) => spider.id === rescuer.id);
          expect(helper?.health).toBeGreaterThan(0);
          expect(helper?.position.y).toBeLessThan(rescuer.position.y - 50);
          expect(await game.getShipHealth()).toBeGreaterThan(0);
          await stage('rescued-with-rendered-attachment');
          await page.screenshot({
            path: screenshotManager.getScreenshotPath(`spider-rescue-freed-${width}.png`),
          });
        },
        { evidence: () => observation?.evaluate((observer) => observer.evidence()) }
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      const image = await observation?.evaluate((observer) => observer.image());
      if (image?.startsWith('data:image/png;base64,')) {
        writeFileSync(
          screenshotManager.getScreenshotPath(`spider-rescue-tow-${width}.png`),
          Buffer.from(image.slice('data:image/png;base64,'.length), 'base64')
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await observation?.evaluate((observer) => observer.stop());
    } catch (error) {
      failures.push(error);
    }
    try {
      await observation?.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Rescue scenario or observer cleanup failed');
    }
    for (const article of ['terrain', 'hauler']) {
      await page.goto(`${TestConfig.GAME_URL}/wiki/#${article}`);
      const rescueRule = page
        .locator('p')
        .filter({
          hasText: article === 'hauler' ? 'Towing a living spider' : 'towing calls rescuers',
        })
        .last();
      await rescueRule.waitFor({ state: 'visible' });
      await rescueRule.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`spider-rescue-wiki-${article}-${width}.png`),
      });
    }
    assertNoBrowserDiagnostics(diagnostics);
  }, 60000);
}
