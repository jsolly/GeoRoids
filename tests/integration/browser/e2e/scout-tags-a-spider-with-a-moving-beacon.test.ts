import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { TOWN_HEARTH } from '../../../../shared/furnaces';
import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import type { Position, SpiderFieldState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';
import { centerOf } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
function field(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
  );
}
for (const width of [1280, 390]) {
  test(`a Scout tags a moving spider and reads the tool rules at ${width}px`, async () => {
    const mobile = width === 390;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const decoder = new SnapshotDecoder();
    const serverPoses = new Map<string, { position: Position; angle: number }>();
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        const result = decoder.readMessage(String(payload), { acceptSnapshots: true });
        if (result.kind === 'snapshot-rejected') {
          throw result.error;
        }
        if (result.kind === 'snapshot') {
          for (const entity of result.state.entities) {
            serverPoses.set(entity.id, { position: entity.position, angle: entity.angle });
          }
        }
      });
    });
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    await game.collectEquipment(['survey_probe']);
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
    await expect.poll(async () => (await field(page)).spiders.length).toBe(1);
    const target = (await field(page)).spiders[0];
    if (!target) {
      throw new Error('Missing spider');
    }
    // A probe is a server hitscan: track the moving spider until both the
    // predicted ship and its acknowledged pose point at the current target.
    await expect
      .poll(
        async () => {
          const current = (await field(page)).spiders.find((spider) => spider.id === target.id);
          if (!current) {
            throw new Error('Spider disappeared before launch');
          }
          await game.pointAtWorldPosition(current.position);
          const local = {
            position: await game.getShipPosition(),
            angle: await game.getShipAngle(),
          };
          const server = serverPoses.get(id);
          if (!server) {
            return Math.PI;
          }
          return Math.max(
            ...[local, server].map((pose) => {
              const desired = Math.atan2(
                pose.position.y - current.position.y,
                current.position.x - pose.position.x
              );
              return Math.abs(
                Math.atan2(Math.sin(pose.angle - desired), Math.cos(pose.angle - desired))
              );
            })
          );
        },
        { timeout: 5000, interval: 16 }
      )
      .toBeLessThan(0.02);
    // Release the steering command before the UI tap; a held off-center
    // cursor would keep turning with the travel-relative camera during it.
    const center = await centerOf(page, '#gameCanvas');
    await page.mouse.move(center.x, center.y);
    await page.evaluate(() => {
      window.gameController?.updateNetworkPlayerState();
    });
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
    for (const route of ['hauler', 'scout', 'terrain']) {
      await page.goto(new URL(`/wiki/#${route}`, page.url()).href);
      const heading = page
        .getByRole('heading', {
          name: route === 'hauler' ? 'Hauler' : route === 'scout' ? 'Scout' : 'Spider tools',
          exact: true,
        })
        .first();
      await heading.waitFor();
      const changedText = page
        .locator('p')
        .filter({
          hasText:
            route === 'hauler'
              ? 'Tap a spider for limited silk'
              : route === 'scout'
                ? 'tagging a guard can reveal its resource nest'
                : 'Scouts can attach a probe to follow a guard home',
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
