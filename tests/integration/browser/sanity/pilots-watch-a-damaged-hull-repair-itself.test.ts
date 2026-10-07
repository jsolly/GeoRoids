// @vitest-environment node
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { DAMAGE } from '../../../../src/constants';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField, getFixtureState } from '../../utils/test-server-control';

const { browserManager, screenshotManager, ownCleanup } = createBrowserScenarioHooks(__dirname);

/** Observe native canvas strokes without replacing the production rendering. */
async function renderedHealthFraction(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const canvas = document.querySelector('#gameCanvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('Game canvas is unavailable');
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Foreground canvas context is unavailable');
    }
    const moveTo = ctx.moveTo;
    const lineTo = ctx.lineTo;
    const stroke = ctx.stroke;
    let from = { x: 0, y: 0 };
    let to = { x: 0, y: 0 };
    let previous: { x: number; y: number; width: number } | undefined;
    const fractions: number[] = [];
    ctx.moveTo = function (this: CanvasRenderingContext2D, x, y) {
      from = { x, y };
      moveTo.call(this, x, y);
    };
    ctx.lineTo = function (this: CanvasRenderingContext2D, x, y) {
      to = { x, y };
      lineTo.call(this, x, y);
    };
    ctx.stroke = function (this: CanvasRenderingContext2D, path?: Path2D) {
      const width = to.x - from.x;
      if (from.y === to.y && width > 0) {
        if (
          String(this.strokeStyle).toLowerCase() === '#4ade80' &&
          previous &&
          previous.x === from.x &&
          previous.y === from.y
        ) {
          fractions.push(width / previous.width);
        }
        previous = { x: from.x, y: from.y, width };
      }
      if (path) {
        stroke.call(this, path);
      } else {
        this === ctx && Reflect.apply(stroke, this, []);
      }
    };
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (fractions.length !== 1) {
        throw new Error(`Expected one damaged hull capsule, saw ${fractions.length}`);
      }
      return fractions[0] ?? 0;
    } finally {
      ctx.moveTo = moveTo;
      ctx.lineTo = lineTo;
      ctx.stroke = stroke;
    }
  });
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`a ${viewport.name} pilot and teammate see an impacted hull repair itself`, async () => {
    const targetPage = await browserManager.createPage({ hasTouch: viewport.name === 'mobile' });
    const observerPage = await browserManager.createPage();
    await targetPage.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(targetPage);
    const observerDiagnostics = watchBrowserDiagnostics(observerPage);
    const target = new GameInteractions(targetPage);
    const observer = new GameInteractions(observerPage);
    await target.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    await observer.bootGame({ kitId: 'scout', waitForCombatReady: false });
    // Hold the UI fixture still while native input, snapshots and healing continue.
    const targetPageThrust = await targetPage.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Fixture ship unavailable');
      }
      const thrust = ship.thrust;
      ship.thrust = 0;
      return thrust;
    });
    ownCleanup(() =>
      targetPage.evaluate((thrust) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        if (!ship) {
          throw new Error('Fixture ship unavailable during cleanup');
        }
        ship.thrust = thrust;
      }, targetPageThrust)
    );
    // Hold the UI fixture still while native input, snapshots and healing continue.
    const observerPageThrust = await observerPage.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Fixture ship unavailable');
      }
      const thrust = ship.thrust;
      ship.thrust = 0;
      return thrust;
    });
    ownCleanup(() =>
      observerPage.evaluate((thrust) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        if (!ship) {
          throw new Error('Fixture ship unavailable during cleanup');
        }
        ship.thrust = thrust;
      }, observerPageThrust)
    );
    const targetId = await target.getLocalPlayerId();
    const observerId = await observer.getLocalPlayerId();
    await target.waitForRemotePlayers(1);
    await observer.waitForRemotePlayers(1);
    const miningEpochs = await arrangeCrewField([targetId, observerId], 'hull-recovery');
    await target.waitForControlledFixture(miningEpochs.get(targetId));
    await observer.waitForControlledFixture(miningEpochs.get(observerId));
    const maxHealth = await target.getShipMaxHealth();
    await expect.poll(() => target.getShipHealth()).toBe(maxHealth);
    // The fixture positions a single ordinary rock; real collision owns the damage.
    await target.placeControlledShipAt(0, -620);
    await expect
      .poll(() => target.getShipHealth(), { timeout: 4000 })
      .toBe(maxHealth - DAMAGE.ASTEROID_COLLISION);
    const damagedHealth = maxHealth - DAMAGE.ASTEROID_COLLISION;
    const emptyEpochs = await arrangeCrewField([targetId, observerId], 'empty');
    await target.waitForControlledFixture(emptyEpochs.get(targetId));
    await observer.waitForControlledFixture(emptyEpochs.get(observerId));
    await expect
      .poll(() => observer.getPlayerHealthById(targetId), { timeout: 2000 })
      .toBe(damagedHealth);
    const targetDamagedBar = await renderedHealthFraction(targetPage);
    const observerDamagedBar = await renderedHealthFraction(observerPage);
    expect(targetDamagedBar).toBeCloseTo(damagedHealth / maxHealth, 2);
    expect(observerDamagedBar).toBeCloseTo(damagedHealth / maxHealth, 2);
    await targetPage.screenshot({
      path: screenshotManager.getScreenshotPath(`regen-${viewport.name}-damaged.png`),
    });
    // Wait on server-owned recovery, not a browser clock or a health assignment.
    await expect
      .poll(
        async () => {
          const state = await getFixtureState();
          const ship = state.players.find((player) => player.id === targetId);
          assert.ok(ship);
          expect(ship.exploding).toBe(false);
          return ship.health;
        },
        { timeout: 9000, interval: 100 }
      )
      .toBeGreaterThan(damagedHealth + maxHealth * 0.02);
    await expect
      .poll(() => target.getShipHealth(), { timeout: 2000 })
      .toBeGreaterThan(damagedHealth + maxHealth * 0.02);
    await expect
      .poll(() => observer.getPlayerHealthById(targetId), { timeout: 2000 })
      .toBeGreaterThan(damagedHealth + maxHealth * 0.02);
    expect(await renderedHealthFraction(targetPage)).toBeGreaterThan(targetDamagedBar + 0.02);
    expect(await renderedHealthFraction(observerPage)).toBeGreaterThan(observerDamagedBar + 0.02);
    const authoritative = (await getFixtureState()).players.find(
      (player) => player.id === targetId
    );
    assert.ok(authoritative);
    expect(Math.abs((await target.getShipHealth()) - authoritative.health)).toBeLessThan(0.5);
    expect(
      Math.abs((await observer.getPlayerHealthById(targetId)) - authoritative.health)
    ).toBeLessThan(0.5);
    await targetPage.screenshot({
      path: screenshotManager.getScreenshotPath(`regen-${viewport.name}-recovering.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(observerDiagnostics);
  }, 20000);
}
