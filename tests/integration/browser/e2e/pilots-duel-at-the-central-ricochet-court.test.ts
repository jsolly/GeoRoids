import { expect, test } from 'vitest';
import { RICOCHET_COURT } from '../../../../shared/ricochetCourt';
import { DAMAGE } from '../../../../src/constants';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';
import { canvasPoint } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])('two pilots bank a damaging shot at the court at $width pixels', async (viewport) => {
  const mobile = viewport.width < 600;
  const page = await browserManager.recreatePage({ hasTouch: mobile });
  await page.setViewportSize(viewport);
  const other = await browserManager.createAdditionalPage();
  const diagnostics = watchBrowserDiagnostics(page);
  const otherDiagnostics = watchBrowserDiagnostics(other);
  const pilot = new GameInteractions(page);
  const target = new GameInteractions(other);
  await pilot.bootGame({ waitForCombatReady: false });
  await target.bootGame({ kitId: 'hauler', waitForCombatReady: false });
  const pilotId = await pilot.getLocalPlayerId();
  const targetId = await target.getLocalPlayerId();
  await Promise.all([pilot.waitForRemotePlayers(1), target.waitForRemotePlayers(1)]);
  await arrangeCrewField([pilotId, targetId], 'empty');
  await Promise.all([pilot.placeShipAt(910, -860), target.placeShipAt(1010, -760)]);
  await page.evaluate(() => {
    const ship = window.gameController?.getCurrPlayer()?.ship;
    if (!ship) {
      throw new Error('Missing pilot');
    }
    ship.angle = 0;
  });
  const health = await target.getShipHealth();
  if (mobile) {
    const point = await canvasPoint(page, 0.7, 0.5);
    await page.touchscreen.tap(point.x, point.y);
  } else {
    await page.keyboard.down('Space');
    try {
      await pilot.waitForAnimationFrames(2);
    } finally {
      await page.keyboard.up('Space');
    }
  }
  await target.waitForShipHealth(health - DAMAGE.LASER_HIT, 5000);
  await expect.poll(() => pilot.getPlayerHealthById(targetId)).toBe(health - DAMAGE.LASER_HIT);

  // Real steering carries the hull through the same panel that reflected its shot.
  const before = await pilot.getShipHealth();
  await page.mouse.move(viewport.width - 20, viewport.height / 2);
  await page.waitForFunction(
    () => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      return ship && ship.position.x > 1040;
    },
    undefined,
    { timeout: 10000 }
  );
  expect(await pilot.getShipHealth()).toBe(before);

  await pilot.placeShipAt(RICOCHET_COURT.center.x, RICOCHET_COURT.center.y);
  await pilot.waitForAnimationFrames(2);
  await page.screenshot({
    path: screenshotManager.getScreenshotPath(`court-${viewport.width}.png`),
  });
  await page.locator('#universe-map-toggle').click();
  await page.locator('#universe-map-dialog').waitFor({ state: 'visible' });
  expect(await page.locator('#universe-map-locations').textContent()).toContain('Ricochet Court');
  await page.screenshot({
    path: screenshotManager.getScreenshotPath(`court-map-${viewport.width}.png`),
  });
  await page.locator('#universe-map-close').click();
  await page.locator('#universe-map-dialog').waitFor({ state: 'hidden' });
  await page.goto(`${TestConfig.GAME_URL}/wiki/#combat-survival`);
  await page.getByRole('heading', { name: 'Ricochet Court', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Ricochet Court', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: screenshotManager.getScreenshotPath(`court-wiki-${viewport.width}.png`),
  });
  assertNoBrowserDiagnostics(diagnostics);
  assertNoBrowserDiagnostics(otherDiagnostics);
});
