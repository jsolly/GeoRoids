// @vitest-environment node
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
  'Hauler swaps hardware and receives four ejected canisters at %i pixels',
  async (width) => {
    const mobile = width === 390;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize({ width, height: 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const decoder = new SnapshotDecoder();
    const drops = new Set<string>();
    const ejections: string[] = [];
    const seenLoot = new Set<string>();
    let observingTap = false;
    const unannouncedDrops: string[] = [];
    const interruptedSessions: string[] = [];
    page.on('websocket', (socket) => {
      if (!WS_PATH.test(socket.url())) {
        return;
      }
      if (observingTap) {
        interruptedSessions.push('replacement socket');
      }
      socket.on('close', () => {
        if (observingTap) {
          interruptedSessions.push('closed socket');
        }
      });
      socket.on('framereceived', ({ payload }) => {
        const result = decoder.readMessage(String(payload), { acceptSnapshots: true });
        if (result.kind === 'snapshot') {
          for (const loot of result.state.loot ?? []) {
            if (observingTap && loot.kind === 'tap' && !seenLoot.has(loot.id)) {
              if (!ejections.includes(loot.id)) {
                unannouncedDrops.push(loot.id);
              }
              drops.add(loot.id);
            }
            seenLoot.add(loot.id);
          }
        } else if (
          result.kind === 'message' &&
          typeof result.message === 'object' &&
          result.message !== null &&
          'type' in result.message &&
          result.message.type === 'joined'
        ) {
          if (observingTap) {
            interruptedSessions.push('replacement join');
          }
          decoder.reset();
        } else if (
          observingTap &&
          result.kind === 'message' &&
          typeof result.message === 'object' &&
          result.message !== null &&
          'type' in result.message &&
          result.message.type === 'tapEjected' &&
          'data' in result.message &&
          typeof result.message.data === 'object' &&
          result.message.data !== null &&
          'lootId' in result.message.data &&
          typeof result.message.data.lootId === 'string'
        ) {
          ejections.push(result.message.data.lootId);
        }
      });
    });
    const game = new GameInteractions(page);
    await game.bootGame({
      kitId: 'hauler',
      waitForCombatReady: false,
    });
    await game.collectEquipment(['resource_tap'], 'resource_tap');
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
      const epochs = await arrangeCrewField([id], 'tow');
      await game.waitForControlledFixture(epochs.get(id));
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
      // The shared server can retain earlier runs' canisters. Observe new
      // drops only after this pilot starts the Resource Tap action.
      observingTap = utility === 'resource_tap';
      if (utility === 'tow_cable') {
        const target = (await game.getAsteroidPositions()).find(
          (rock) => rock.id === 'crew-fixture-ore'
        );
        if (!target) {
          throw new Error('Missing tow target');
        }
        // Leave enough launch range for the automatic cruise while the pilot turns.
        await game.placeControlledShipAt(target.x - 160, target.y);
        await game.aimAtWorldPosition(target);
      }
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
        // Exact 23/45/68/90-frame cadence is proved by the controlled server
        // scenario in tap-extract-spawns-tap-loot.test.ts. Snapshot arrival
        // frames cannot identify birth frames when simulation and transport lag.
        await expect.poll(() => ejections.length).toBe(4);
        expect(new Set(ejections).size).toBe(4);
        expect(unannouncedDrops).toEqual([]);
        expect(interruptedSessions).toEqual([]);
        expect([...drops].sort()).toEqual([...ejections].sort());
      }
    }
    expect(page.url().startsWith(TestConfig.GAME_URL)).toBe(true);
    assertNoBrowserDiagnostics(diagnostics);
  }
);
