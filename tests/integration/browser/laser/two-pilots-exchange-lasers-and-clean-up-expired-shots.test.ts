import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import type { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import {
  bootLaserClients,
  localPlayerId,
  observeLaser,
  parkLaserClients,
  waitForLaserCleanup,
} from './laser-observation';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

async function expectPilotsAliveWithUnchangedHealth(
  game1: GameInteractions,
  game2: GameInteractions,
  id1: string,
  id2: string,
  expectedHealth: readonly [number, number]
): Promise<void> {
  const [
    health1,
    health2,
    exploding1,
    exploding2,
    remoteHealth1,
    remoteHealth2,
    remoteIds1,
    remoteIds2,
  ] = await Promise.all([
    game1.getShipHealth(),
    game2.getShipHealth(),
    game1.isShipExploding(),
    game2.isShipExploding(),
    game1.getPlayerHealthById(id2),
    game2.getPlayerHealthById(id1),
    game1.getRemotePlayerIds(),
    game2.getRemotePlayerIds(),
  ]);

  expect(health1).toBe(expectedHealth[0]);
  expect(health2).toBe(expectedHealth[1]);
  expect(health1).toBeGreaterThan(0);
  expect(health2).toBeGreaterThan(0);
  expect(exploding1).toBe(false);
  expect(exploding2).toBe(false);
  expect(remoteIds1).toContain(id2);
  expect(remoteIds2).toContain(id1);
  expect(remoteHealth1).toBeGreaterThan(0);
  expect(remoteHealth2).toBeGreaterThan(0);
}

test(
  'two pilots exchange matching laser state and remove each expired shot',
  async () => {
    const { page1, page2, game1, game2 } = await bootLaserClients(browserManager);
    const diagnostics1 = watchBrowserDiagnostics(page1);
    const diagnostics2 = watchBrowserDiagnostics(page2);
    const id1 = await localPlayerId(page1);
    const id2 = await localPlayerId(page2);
    const healthBeforeFirstExchange: [number, number] = [
      await game1.getShipHealth(),
      await game2.getShipHealth(),
    ];
    await expectPilotsAliveWithUnchangedHealth(game1, game2, id1, id2, healthBeforeFirstExchange);

    const [local1, remote1] = await Promise.all([
      observeLaser(page1, id1, false),
      observeLaser(page2, id1, true),
      game1.fireLasersWithMouse(1),
    ]);
    expect(remote1.ownerId).toBe(id1);
    expect(remote1.vx).toBeCloseTo(local1.vx, 4);
    expect(remote1.vy).toBeCloseTo(local1.vy, 4);
    await Promise.all([
      waitForLaserCleanup(page1, id1, false),
      waitForLaserCleanup(page2, id1, true),
    ]);
    await expectPilotsAliveWithUnchangedHealth(game1, game2, id1, id2, healthBeforeFirstExchange);

    await parkLaserClients([game1, game2]);
    const healthBeforeSecondExchange: [number, number] = [
      await game1.getShipHealth(),
      await game2.getShipHealth(),
    ];
    expect(healthBeforeSecondExchange).toEqual(healthBeforeFirstExchange);
    await expectPilotsAliveWithUnchangedHealth(game1, game2, id1, id2, healthBeforeSecondExchange);

    const [local2, remote2] = await Promise.all([
      observeLaser(page2, id2, false),
      observeLaser(page1, id2, true),
      game2.fireLasersWithMouse(1),
    ]);
    expect(remote2.ownerId).toBe(id2);
    expect(remote2.vx).toBeCloseTo(local2.vx, 4);
    expect(remote2.vy).toBeCloseTo(local2.vy, 4);
    await Promise.all([
      waitForLaserCleanup(page2, id2, false),
      waitForLaserCleanup(page1, id2, true),
    ]);
    await expectPilotsAliveWithUnchangedHealth(game1, game2, id1, id2, healthBeforeSecondExchange);
    await page1.screenshot({
      path: screenshotManager.getScreenshotPath('slower-projectiles-desktop.png'),
    });
    assertNoBrowserDiagnostics(diagnostics1);
    assertNoBrowserDiagnostics(diagnostics2);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
