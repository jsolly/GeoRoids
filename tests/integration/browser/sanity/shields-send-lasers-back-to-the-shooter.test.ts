import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([1280, 390])(
  'Hauler reflects an incoming laser with its F shield at %i pixels',
  async (width) => {
    const defenderPage = browserManager.getCurrentPage();
    if (!defenderPage) {
      throw new Error('Defender page unavailable');
    }
    const diagnostics = watchBrowserDiagnostics(defenderPage);
    await defenderPage.setViewportSize({ width, height: 900 });
    const attacker = new GameInteractions(await browserManager.createAdditionalPage());
    await attacker.bootGame({ kitId: 'surveyor', waitForCombatReady: true });
    await attacker.placeShipAt(-1800, 0);
    const defender = new GameInteractions(defenderPage);
    await defender.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    await defender.placeShipAt(-1700, 0);
    await attacker.waitForRemoteHumanPlayers(1);
    await defenderPage.keyboard.press('KeyF');
    await expect
      .poll(() =>
        defenderPage.evaluate(() => window.gameController?.getCurrPlayer()?.ship.shieldTime ?? 0)
      )
      .toBeGreaterThan(0);
    const defenderHealth = await defender.getShipHealth();
    const attackerHealth = await attacker.getShipHealth();
    await attacker.fireLaserAtRemotePlayer(await defender.getLocalPlayerId(), 100);
    await expect.poll(() => attacker.getShipHealth(), { timeout: 4000 }).toBe(attackerHealth - 25);
    expect(await defender.getShipHealth()).toBe(defenderHealth);
    await defenderPage.screenshot({
      path: screenshotManager.getScreenshotPath(`hauler-reflecting-shield-${width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
