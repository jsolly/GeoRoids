import { expect, test } from 'vitest';
import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
const WS_PATH = /\/ws(?:\?|$)/u;

test.each([1280, 954, 390])(
  'Hauler swaps hardware and extracts spaced loot at %i pixels',
  async (width) => {
    const mobile = width === 390;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize({ width, height: 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const decoder = new SnapshotDecoder();
    const drops = new Map<string, number>();
    page.on('websocket', (socket) => {
      if (!WS_PATH.test(socket.url())) {
        return;
      }
      socket.on('framereceived', ({ payload }) => {
        const result = decoder.readMessage(String(payload), { acceptSnapshots: true });
        if (result.kind === 'snapshot') {
          for (const loot of result.state.loot ?? []) {
            if (loot.kind === 'tap' && !drops.has(loot.id)) {
              drops.set(loot.id, result.state.gameTime);
            }
          }
        } else if (
          result.kind === 'message' &&
          typeof result.message === 'object' &&
          result.message !== null &&
          'type' in result.message &&
          result.message.type === 'joined'
        ) {
          decoder.reset();
        }
      });
    });
    const game = new GameInteractions(page);
    await game.bootGame({
      kitId: 'hauler',
      haulerUtility: 'resource_tap',
      waitForCombatReady: false,
    });
    const id = await game.getLocalPlayerId();
    const openSchematic = async () => {
      if (mobile) {
        await page.locator('#ship-schematic-toggle').tap();
      } else {
        await page.keyboard.press('v');
      }
      await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
    };
    const useAbility = () =>
      mobile ? page.locator('#touch-ability').tap() : page.keyboard.press('e');
    for (const utility of ['tow_cable', 'resource_tap'] as const) {
      await arrangeCrewField([id], 'tow');
      await game.waitForAnimationFrames(10);
      await openSchematic();
      const layout = () =>
        page.evaluate(() =>
          [
            '#ship-schematic-dialog',
            '#ship-schematic-canvas',
            '#ship-schematic-tool',
            '#ship-schematic-return',
            '.ship-schematic-card-name',
          ].map((selector) => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
          })
        );
      const beforeSwitch = await layout();
      const card = page.locator(`[data-utility-id="${utility}"]`);
      if (mobile) {
        await card.tap();
      } else {
        await card.click();
      }
      await expect
        .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.haulerUtility))
        .toBe(utility);
      await game.waitForAnimationFrames(35);
      expect(await layout()).toEqual(beforeSwitch);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`equipment-${utility}-${width}.png`),
      });
      await page.locator('#ship-schematic-return').click();
      await useAbility();
      await expect
        .poll(() =>
          page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId)
        )
        .toBe('crew-fixture-ore');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`latch-${utility}-${width}.png`),
      });
      if (utility === 'tow_cable') {
        await useAbility();
        await expect
          .poll(() =>
            page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId)
          )
          .toBeNull();
      } else {
        await expect
          .poll(() => drops.size, { timeout: 5000, interval: 50 })
          .toBeGreaterThanOrEqual(3);
        await page.screenshot({
          path: screenshotManager.getScreenshotPath(`tap-popouts-${width}.png`),
        });
        await expect.poll(() => drops.size, { timeout: 5000 }).toBe(4);
        await expect
          .poll(() =>
            page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId)
          )
          .toBeNull();
        const frames = [...drops.values()];
        for (let i = 1; i < frames.length; i++) {
          // Each 22/23-frame burst is sampled by the 30 Hz authoritative snapshots.
          const gap = (frames[i] ?? 0) - (frames[i - 1] ?? 0);
          expect(gap).toBeGreaterThanOrEqual(20);
          expect(gap).toBeLessThanOrEqual(25);
        }
      }
    }
    expect(page.url().startsWith(TestConfig.GAME_URL)).toBe(true);
    assertNoBrowserDiagnostics(diagnostics);
  }
);
