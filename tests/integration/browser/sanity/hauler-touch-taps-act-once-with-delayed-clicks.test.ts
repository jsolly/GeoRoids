import { chromium, webkit } from 'playwright';
import { describe, expect, test } from 'vitest';
import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

for (const browserType of [chromium, webkit]) {
  describe(browserType.name(), () => {
    const { browserManager, screenshotManager } = createBrowserScenarioHooks(
      __dirname,
      browserType
    );

    test.each([0, 250])(
      'one Hauler tap stays hooked when its click arrives %i ms later',
      async (delay) => {
        const page = await browserManager.recreatePage({ hasTouch: true });
        await page.setViewportSize({ width: 390, height: 844 });
        const diagnostics = watchBrowserDiagnostics(page);
        const decoder = new SnapshotDecoder();
        const targets: unknown[] = [];
        const protocolErrors: string[] = [];
        let requests = 0;
        let snapshots = 0;
        page.on('websocket', (socket) => {
          if (!/\/ws(?:\?|$)/.test(socket.url())) {
            return;
          }
          socket.on('framesent', ({ payload }) => {
            try {
              const message: unknown = JSON.parse(String(payload));
              if (
                message &&
                typeof message === 'object' &&
                'type' in message &&
                message.type === 'useAbility'
              ) {
                requests++;
              }
            } catch (error) {
              protocolErrors.push(String(error));
            }
          });
          socket.on('framereceived', ({ payload }) => {
            try {
              const result = decoder.readMessage(String(payload), { acceptSnapshots: true });
              if (result.kind === 'snapshot-rejected') {
                throw result.error;
              }
              if (result.kind === 'snapshot') {
                snapshots++;
                return;
              }
              const message = result.message;
              if (!message || typeof message !== 'object' || !('type' in message)) {
                return;
              }
              if (message.type === 'joined') {
                decoder.reset();
              }
              if (
                message.type === 'abilityUsed' &&
                'data' in message &&
                message.data &&
                typeof message.data === 'object' &&
                'harpoonTargetId' in message.data
              ) {
                targets.push(message.data.harpoonTargetId);
              }
            } catch (error) {
              protocolErrors.push(String(error));
            }
          });
        });

        const game = new GameInteractions(page);
        await game.bootGame({
          kitId: 'hauler',
          haulerUtility: 'tow_cable',
          waitForCombatReady: false,
        });
        await arrangeCrewField([await game.getLocalPlayerId()], 'delivery');
        await page.waitForFunction(() =>
          window.gameController
            ?.getCurrRoidBelt()
            .getRoids()
            .some((rock) => rock.id === 'crew-fixture-ore')
        );
        const ability = page.locator('#touch-ability');
        await ability.tap();
        await expect.poll(() => targets).toEqual(['crew-fixture-ore']);
        await expect.poll(() => ability.textContent()).toBe('RELEASE');
        // Emulate the follow-up pointer click independently of the browser's tap
        // heuristic. It may arrive in a later task after the server confirms Hook.
        await page.waitForTimeout(delay);
        await ability.dispatchEvent('click', { bubbles: true, detail: 1 });
        const afterHook = snapshots;
        await expect.poll(() => snapshots).toBeGreaterThan(afterHook + 4);
        expect(requests).toBe(1);
        expect(targets).toEqual(['crew-fixture-ore']);
        expect(await ability.textContent()).toBe('RELEASE');
        expect(
          await page.evaluate(
            () => window.gameController?.getCurrPlayer()?.ship.abilityCooldownFrames
          )
        ).toBeGreaterThan(0);
        await page.screenshot({
          path: screenshotManager.getScreenshotPath(
            `hauler-single-tap-${browserType.name()}-${delay}.png`
          ),
        });

        // Cover release both during cooldown and after a new hook is allowed.
        // In the latter case a duplicate request would immediately reattach.
        if (delay > 0) {
          await page.waitForFunction(
            () => window.gameController?.getCurrPlayer()?.ship.abilityCooldownFrames === 0
          );
          expect(targets).toEqual(['crew-fixture-ore']);
        }
        await ability.tap();
        await expect.poll(() => targets).toEqual(['crew-fixture-ore', null]);
        await page.waitForTimeout(delay);
        await ability.dispatchEvent('click', { bubbles: true, detail: 1 });
        const afterRelease = snapshots;
        await expect.poll(() => snapshots).toBeGreaterThan(afterRelease + 4);
        expect(requests).toBe(2);
        expect(targets).toEqual(['crew-fixture-ore', null]);
        expect(await ability.textContent()).toBe('HOOK');
        expect(
          await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId)
        ).toBeNull();
        expect(protocolErrors).toEqual([]);
        assertNoBrowserDiagnostics(diagnostics);
      }
    );
  });
}
