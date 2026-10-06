// @vitest-environment node
import { expect, test } from 'vitest';
import { cargoCapacity } from '../../../../shared/economy';
import { DAMAGE } from '../../../../src/constants';
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
  test(`full ${viewport.kitId} holds leave loot for the crew and show filled cargo bays on both ships at ${viewport.width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const peerPage = await browserManager.createAdditionalPage();
    const diagnostics = watchBrowserDiagnostics(page);
    const peerDiagnostics = watchBrowserDiagnostics(peerPage);
    const game = new GameInteractions(page);
    const peer = new GameInteractions(peerPage);
    await game.bootGame({
      field: 'controlled',
      kitId: viewport.kitId,
      waitForCombatReady: false,
    });
    const playerId = await game.getLocalPlayerId();
    const emptyEpochs = await arrangeCrewField([playerId], 'empty');
    await game.waitForControlledFixture(emptyEpochs.get(playerId));
    await peer.bootGame({ field: 'controlled', waitForCombatReady: false });
    for (const target of [page, peerPage]) {
      await target.evaluate(() => {
        const drawText = CanvasRenderingContext2D.prototype.fillText;
        let badges = 0;
        CanvasRenderingContext2D.prototype.fillText = function (
          this: CanvasRenderingContext2D,
          text,
          x,
          y,
          maxWidth
        ) {
          if (this.canvas.id === 'gameCanvas' && text === 'CARGO FULL') {
            badges++;
          }
          if (maxWidth === undefined) {
            drawText.call(this, text, x, y);
          } else {
            drawText.call(this, text, x, y, maxWidth);
          }
        };
        function observeFrame() {
          document.documentElement.dataset['cargoFullBadges'] = String(badges);
          badges = 0;
          requestAnimationFrame(observeFrame);
        }
        requestAnimationFrame(observeFrame);
      });
    }
    await page.keyboard.press('Escape');
    await peerPage.keyboard.press('Escape');
    const peerId = await peer.getLocalPlayerId();
    const epochs = await arrangeCrewField([playerId, peerId], 'full-cargo');
    await game.waitForControlledFixture(epochs.get(playerId));
    await peer.waitForControlledFixture(epochs.get(peerId));
    await peer.placeControlledShipAt(120, -500);
    await game.waitForCombatReady();
    await game.placeControlledShipAt(0, -500);
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
    for (const target of [page, peerPage]) {
      await expect
        .poll(() => target.evaluate(() => document.documentElement.dataset['cargoFullBadges']))
        .toBe('2');
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`cargo-full-bays-${viewport.width}.png`),
    });
    await peerPage.screenshot({
      path: screenshotManager.getScreenshotPath(`cargo-full-peer-${viewport.width}.png`),
    });
    await peer.placeControlledShipAt(400, -500);
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
      await game.placeControlledShipAt(drop.x, drop.y);
    }
    const remainingIds = drops.map((drop) => drop.id).sort((a, b) => a.localeCompare(b));
    await page.waitForTimeout(350);
    expect(
      (await game.getLoot()).map((drop) => drop.id).sort((a, b) => a.localeCompare(b))
    ).toEqual(remainingIds);
    expect(
      (await peer.getLoot()).map((drop) => drop.id).sort((a, b) => a.localeCompare(b))
    ).toEqual(remainingIds);
    await peer.placeControlledShipAt(0, 0);
    await expect.poll(() => peer.getCargo(), { timeout: 8000 }).toBe(0);
    for (const drop of drops) {
      await peer.placeControlledShipAt(drop.x, drop.y);
    }
    await expect.poll(() => peer.getCargo()).toBeGreaterThan(0);
    await expect.poll(() => game.getLoot()).toEqual([]);
    await expect.poll(() => peer.getLoot()).toEqual([]);
    await expect.poll(() => game.getCargo()).toBe(cargoCapacity(viewport.kitId));
    expect(await game.getScore()).toBe(bank);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`full-cargo-${viewport.width}.png`),
    });
    const impactEpochs = await arrangeCrewField([playerId, peerId], 'impact');
    await game.waitForControlledFixture(impactEpochs.get(playerId));
    await peer.waitForControlledFixture(impactEpochs.get(peerId));
    await expect.poll(() => game.getAsteroidPositions()).toEqual([]);
    expect(await game.getShipHealth()).toBe(DAMAGE.ASTEROID_COLLISION);
    await expect.poll(() => game.getCargo()).toBeLessThan(cargoCapacity(viewport.kitId));
    await expect
      .poll(() =>
        peerPage.evaluate(
          (id) =>
            window.gameController
              ?.getNetworkManager()
              .getAllPlayers()
              .find((pilot) => pilot.id === id)?.ship.health,
          playerId
        )
      )
      .toBe(DAMAGE.ASTEROID_COLLISION);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`cargo-protection-${viewport.width}.png`),
    });
    await page.waitForTimeout(500);
    expect(await game.getShipHealth()).toBe(DAMAGE.ASTEROID_COLLISION);
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(peerDiagnostics);
  }, 60000);
}
