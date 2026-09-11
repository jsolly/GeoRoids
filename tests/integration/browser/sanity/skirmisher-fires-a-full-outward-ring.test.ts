import { expect, test } from 'vitest';
import { SKIRMISHER_RING_COUNT } from '../../../../src/entities/ship/skirmisherRing';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([1280, 390])(
  'Skirmisher fires one authoritative outward ring at %i pixels',
  async (width) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Skirmisher page unavailable');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height: 900 });
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'skirmisher', waitForCombatReady: false });
    await game.placeShipAt(-1700, 0);
    const observerPage = await browserManager.createAdditionalPage();
    const observerDiagnostics = watchBrowserDiagnostics(observerPage);
    const observer = new GameInteractions(observerPage);
    await observer.bootGame({ waitForCombatReady: false });
    await observer.placeShipAt(-1700, 500);
    await game.waitForRemoteHumanPlayers(1);
    const id = await page.evaluate(() => window.gameController?.getCurrPlayer()?.id);
    if (!id) {
      throw new Error('Skirmisher did not join');
    }
    await page.keyboard.press('KeyE');
    await page.waitForFunction(
      (count) =>
        window.gameController?.getCurrPlayer()?.ship.lasers.filter((laser) => laser.serverId)
          .length === count,
      SKIRMISHER_RING_COUNT
    );
    const shots = await page.evaluate(
      () =>
        window.gameController?.getCurrPlayer()?.ship.lasers.map((laser) => ({
          id: laser.serverId,
          x: laser.velocity.x,
          y: laser.velocity.y,
        })) ?? []
    );
    expect(shots).toHaveLength(SKIRMISHER_RING_COUNT);
    expect(new Set(shots.map((shot) => shot.id)).size).toBe(SKIRMISHER_RING_COUNT);
    const carryX = shots.reduce((sum, shot) => sum + shot.x, 0) / shots.length;
    const carryY = shots.reduce((sum, shot) => sum + shot.y, 0) / shots.length;
    const angles = shots
      .map((shot) => Math.atan2(shot.y - carryY, shot.x - carryX))
      .sort((a, b) => a - b);
    for (let index = 0; index < angles.length; index++) {
      const angle = angles[index];
      const next = angles[(index + 1) % angles.length];
      if (angle === undefined || next === undefined) {
        throw new Error('Incomplete ring');
      }
      expect((next - angle + Math.PI * 2) % (Math.PI * 2)).toBeCloseTo(
        (Math.PI * 2) / SKIRMISHER_RING_COUNT,
        4
      );
    }
    await observerPage.waitForFunction(
      ({ owner, count }) =>
        window.gameController
          ?.getNetworkManager()
          .getAllPlayers()
          .find((player) => player.id === owner)
          ?.ship.lasers.filter((laser) => laser.serverId).length === count,
      { owner: id, count: SKIRMISHER_RING_COUNT }
    );
    await page.bringToFront();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`skirmisher-ring-${width}.png`),
    });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => {
      const lasers = window.gameController?.getCurrPlayer()?.ship.lasers ?? [];
      return (
        lasers.some((laser) => laser.abilityShot && laser.serverId) &&
        lasers.some((laser) => !laser.abilityShot && laser.serverId)
      );
    });
    for (const entry of ['skirmisher', 'quake', 'factions']) {
      await page.goto(new URL(`/wiki/#${entry}`, page.url()).href);
      await page.locator('h1').waitFor();
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`${entry}-wiki-${width}.png`),
        fullPage: true,
      });
    }
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(observerDiagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
