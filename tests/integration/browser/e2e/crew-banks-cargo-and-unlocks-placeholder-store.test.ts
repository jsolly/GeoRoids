// @vitest-environment node
import { expect, test } from 'vitest';
import type { SettlementState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { width: 1280, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
]) {
  test(`crew deposits grow the station and buy inert placeholders at ${viewport.width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const peerPage = await browserManager.createAdditionalPage();
    const diagnostics = watchBrowserDiagnostics(page);
    const peerDiagnostics = watchBrowserDiagnostics(peerPage);
    const game = new GameInteractions(page);
    const peer = new GameInteractions(peerPage);
    await game.bootGame({ waitForCombatReady: false });
    await peer.bootGame({ waitForCombatReady: false });
    const firstId = await game.getLocalPlayerId();
    const peerId = await peer.getLocalPlayerId();
    const ids = [firstId, peerId];
    const cargoEpochs = await arrangeCrewField(ids, 'cargo');
    await game.waitForControlledFixture(cargoEpochs.get(firstId));
    await peer.waitForControlledFixture(cargoEpochs.get(peerId));
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.cargo))
      .toBe(400);
    await game.placeControlledShipAt(0, 0);
    await expect.poll(() => game.getScore()).toBe(700);
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.cargo))
      .toBe(0);
    const readShared = (target: typeof page) =>
      target.evaluate<SettlementState>(
        "import('/src/network/worldExploration.ts').then(module => module.getSettlement())"
      );
    await expect.poll(async () => (await readShared(peerPage)).points).toBe(400);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`economy-station-level1-${viewport.width}.png`),
    });
    const settlementEpochs = await arrangeCrewField(ids, 'settlement-delivery');
    await game.waitForControlledFixture(settlementEpochs.get(firstId));
    await peer.waitForControlledFixture(settlementEpochs.get(peerId));
    await expect.poll(async () => (await readShared(page)).level).toBe(2);
    await expect.poll(async () => (await readShared(peerPage)).level).toBe(2);
    await game.placeControlledShipAt(0, 0);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`economy-station-level2-${viewport.width}.png`),
    });
    const before = await page.evaluate(() => {
      const player = window.gameController?.getCurrPlayer();
      return {
        bank: player?.score ?? 0,
        mass: player?.ship.mass,
        kit: player?.ship.kitId,
        color: player?.color,
      };
    });
    await game.placeControlledShipAt(0, 0);
    if (viewport.touch) {
      await page.getByRole('button', { name: 'Enter', exact: true }).tap();
    } else {
      await page.keyboard.press('KeyB');
    }
    const store = page.locator('#town-store-dialog');
    await store.waitFor({ state: 'visible' });
    await store.getByRole('button', { name: 'Store', exact: true }).click();
    expect(await store.textContent()).toContain('No gameplay effect');
    await store.locator('[data-offer="placeholder-2"]').click();
    await expect.poll(() => game.getScore()).toBe(before.bank - 250);
    expect(await store.locator('[data-offer="placeholder-3"]').isDisabled()).toBe(true);
    expect(await store.locator('[data-offer="placeholder-2"]').isDisabled()).toBe(true);
    const after = await page.evaluate(() => {
      const player = window.gameController?.getCurrPlayer();
      return { mass: player?.ship.mass, kit: player?.ship.kitId, color: player?.color };
    });
    expect(after).toEqual({ mass: before.mass, kit: before.kit, color: before.color });
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`economy-placeholder-store-${viewport.width}.png`),
    });
    await store.locator('#town-store-return').click();
    await store.waitFor({ state: 'hidden' });
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(peerDiagnostics);
  }, 90000);
}
