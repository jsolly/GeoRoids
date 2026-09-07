import { test, expect } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('spawn protection prevents damage', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);
  await game.bootGame({ waitForCombatReady: false });
  // Keep ambient combat away from this single-hit protection scenario while
  // retaining the actual server-issued protection and normal position updates.
  await page.evaluate(() => {
    const ship = (window as any).gameController.playerManager.getLocalPlayer().ship;
    ship.position.x = -1800;
    ship.position.y = -1800;
    ship.velocity.x = 0;
    ship.velocity.y = 0;
  });
  await game.waitForServerSpawnProtection();

  expect(await game.isServerSpawnProtected()).toBe(true);
  await game.applyLaserDamageToLocal(1, 25);
  await page.waitForTimeout(400);
  expect(await game.getShipHealth()).toBe(100);

  await game.waitForCombatReady();
  expect(await game.isServerSpawnProtected()).toBe(false);

  await game.applyLaserDamageToLocal(1, 25);
  await expect
    .poll(() => game.getShipHealth(), { timeout: 5000, message: 'damage should apply after protection ends' })
    .toBe(75);
}, TestConfig.DEFAULT_TIMEOUT);
