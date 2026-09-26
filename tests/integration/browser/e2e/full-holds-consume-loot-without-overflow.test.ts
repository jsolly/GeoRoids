import { expect, test } from 'vitest';
import { cargoCapacity } from '../../../../shared/economy';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { width: 1280, height: 900, touch: false, kitId: 'scout' as const },
  { width: 390, height: 844, touch: true, kitId: 'hauler' as const },
]) {
  test(`full ${viewport.kitId} holds consume loot for both observers at ${viewport.width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const peerPage = await browserManager.createAdditionalPage();
    const diagnostics = watchBrowserDiagnostics(page);
    const peerDiagnostics = watchBrowserDiagnostics(peerPage);
    const game = new GameInteractions(page);
    const peer = new GameInteractions(peerPage);
    await game.bootGame({ kitId: viewport.kitId });
    await peer.bootGame();
    await arrangeCrewField(
      [await game.getLocalPlayerId(), await peer.getLocalPlayerId()],
      'full-cargo'
    );
    await peer.placeShipAt(400, -500);
    await game.waitForCombatReady();
    await game.placeShipAt(0, -500);
    await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Mining pilot missing');
      }
      ship.angle = Math.PI / 2;
    });
    await expect
      .poll(async () => (await game.getAsteroidPositions()).map((rock) => rock.id))
      .toEqual(['crew-fixture-ore']);
    const bank = await game.getScore();
    await page.keyboard.press('Space');
    await expect
      .poll(async () => (await peer.getLoot()).some((drop) => drop.kind === 'points'))
      .toBe(true);
    let drops: Awaited<ReturnType<GameInteractions['getLoot']>> = [];
    await expect
      .poll(async () => {
        drops = await game.getLoot();
        return drops.some((drop) => drop.kind === 'points');
      })
      .toBe(true);
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) {
      await game.placeShipAt(drop.x, drop.y);
    }
    await expect.poll(() => game.getLoot()).toEqual([]);
    await expect.poll(() => peer.getLoot()).toEqual([]);
    await expect.poll(() => game.getCargo()).toBe(cargoCapacity(viewport.kitId));
    expect(await game.getScore()).toBe(bank);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`full-cargo-${viewport.width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(peerDiagnostics);
  }, 60000);
}
