// @vitest-environment node
import { expect, test } from 'vitest';
import { TOWN_HEARTH } from '../../../../shared/furnaces';
import type { SettlementState } from '../../../../shared-types';
import { hullRadiusForKit } from '../../../../src/entities/ship/shipKits';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';
import { canvasPoint, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { width: 1280, height: 900, touch: false, kitId: 'scout' },
  { width: 1280, height: 900, touch: false, kitId: 'hauler' },
  { width: 390, height: 844, touch: true, kitId: 'scout' },
  { width: 390, height: 844, touch: true, kitId: 'hauler' },
] as const) {
  test(`${viewport.kitId} docks outside the ring, grows the station and buys inert placeholders at ${viewport.width}px`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const peerPage = await browserManager.createAdditionalPage();
    const diagnostics = watchBrowserDiagnostics(page);
    const peerDiagnostics = watchBrowserDiagnostics(peerPage);
    const game = new GameInteractions(page);
    const peer = new GameInteractions(peerPage);
    await game.bootGame({ waitForCombatReady: false, kitId: viewport.kitId });
    await peer.bootGame({ waitForCombatReady: false });
    await page.keyboard.press('Escape');
    await peerPage.keyboard.press('Escape');
    const firstId = await game.getLocalPlayerId();
    const peerId = await peer.getLocalPlayerId();
    const ids = [firstId, peerId];
    const cargoEpochs = await arrangeCrewField(ids, 'cargo');
    await game.waitForControlledFixture(cargoEpochs.get(firstId));
    await peer.waitForControlledFixture(cargoEpochs.get(peerId));
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.cargo))
      .toBe(400);
    await peer.placeControlledShipAt(150, 0);
    for (const target of [page, peerPage]) {
      await target.evaluate(() => {
        const drawText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (
          this: CanvasRenderingContext2D,
          text,
          x,
          y,
          maxWidth
        ) {
          if (text.startsWith('OFFLOADING') || text === 'CARGO BANKED') {
            document.documentElement.dataset['offloadLabel'] = text;
          }
          if (maxWidth === undefined) {
            drawText.call(this, text, x, y);
          } else {
            drawText.call(this, text, x, y, maxWidth);
          }
        };
      });
    }
    const touchSession = viewport.touch ? await page.context().newCDPSession(page) : undefined;
    const approachTouch = { ...(await canvasPoint(page, 0.3, 0.45)), id: 1 };
    try {
      if (touchSession) {
        await dispatchTouch(touchSession, 'touchStart', [approachTouch]);
        await dispatchTouch(touchSession, 'touchMove', [
          { ...approachTouch, x: approachTouch.x + 30 },
        ]);
      } else {
        await page.mouse.move(viewport.width / 2 + 100, viewport.height / 2 - 200);
      }
      const dockX = TOWN_HEARTH.radius + hullRadiusForKit(viewport.kitId) - 1;
      await game.placeControlledShipAt(dockX, 0);
      await expect
        .poll(async () => {
          const cargo = await game.getCargo();
          return cargo > 0 && cargo < 400;
        })
        .toBe(true);
      expect(
        await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.cargoHover)
      ).toBe(true);
      expect(
        await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.position.x)
      ).toBeCloseTo(dockX, 1);
      for (const target of [page, peerPage]) {
        await expect
          .poll(() => target.evaluate(() => document.documentElement.dataset['offloadLabel']))
          .toContain('OFFLOADING');
      }
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(
          `cargo-offload-${viewport.kitId}-${viewport.width}.png`
        ),
      });
      await peerPage.screenshot({
        path: screenshotManager.getScreenshotPath(
          `cargo-offload-peer-${viewport.kitId}-${viewport.width}.png`
        ),
      });
      if (touchSession) {
        await dispatchTouch(touchSession, 'touchMove', [
          { ...approachTouch, y: approachTouch.y + 100 },
        ]);
      } else {
        await page.keyboard.press('ArrowLeft');
      }
      await expect
        .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.cargoHover))
        .toBe(false);
    } finally {
      if (touchSession) {
        await dispatchTouch(touchSession, 'touchEnd', []);
        await touchSession.detach();
      }
    }
    await game.placeControlledShipAt(0, -500);
    const held = await game.getCargo();
    await page.evaluate(() => {
      document.documentElement.dataset['offloadLabel'] = '';
    });
    await page.waitForTimeout(400);
    expect(await game.getCargo()).toBe(held);
    expect(await page.evaluate(() => document.documentElement.dataset['offloadLabel'])).toBe('');
    expect(held).toBeGreaterThan(0);
    expect(
      await page.evaluate(() => {
        const pilot = window.gameController?.getCurrPlayer();
        return pilot ? pilot.score + pilot.cargo : -1;
      })
    ).toBe(700);
    await game.placeControlledShipAt(0, 0);
    await expect.poll(() => game.getScore(), { timeout: 8000 }).toBe(700);
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.cargo))
      .toBe(0);
    for (const target of [page, peerPage]) {
      await expect
        .poll(() => target.evaluate(() => document.documentElement.dataset['offloadLabel']))
        .toBe('CARGO BANKED');
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`cargo-banked-${viewport.width}.png`),
    });
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
