import { expect, test } from 'vitest';
import type { AuthoritativeProjectileField } from '../../../../src/entities/laser/AuthoritativeProjectileField';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField, getWorldDiagnostics } from '../../utils/test-server-control';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'direct crew lasers, overlap, and tow input leave teammates unharmed in an empty field',
  async () => {
    const shooterPage = browserManager.getCurrentPage();
    if (!shooterPage) {
      throw new Error('Shooter page unavailable');
    }
    const teammatePage = await browserManager.createAdditionalPage();
    const shooterDiagnostics = watchBrowserDiagnostics(shooterPage);
    const teammateDiagnostics = watchBrowserDiagnostics(teammatePage);
    const shooter = new GameInteractions(shooterPage);
    const teammate = new GameInteractions(teammatePage);

    await shooter.bootGame({ kitId: 'scout', waitForCombatReady: false });
    await teammate.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    const shooterId = await shooter.getLocalPlayerId();
    const teammateId = await teammate.getLocalPlayerId();
    await Promise.all([shooter.waitForRemotePlayers(1), teammate.waitForRemotePlayers(1)]);
    await arrangeCrewField([shooterId, teammateId], 'empty');
    await Promise.all([shooter.waitForCombatReady(), teammate.waitForCombatReady()]);

    // With no asteroid in the field, a Hauler E press has no valid target and
    // must never reinterpret a nearby crew ship as tow cargo.
    await teammatePage.keyboard.press('KeyE');
    await teammate.waitForAnimationFrames(2);
    expect(
      await teammatePage.evaluate(
        () => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId
      )
    ).toBeNull();

    const beforeHealth = await teammate.getShipHealth();
    const beforeLives = await teammate.getShipHealth();
    const beforeShooterScore = await shooter.getScore();
    const beforeTeammateScore = await teammate.getScore();
    const field = await shooterPage.evaluateHandle<AuthoritativeProjectileField>(
      "import('/src/entities/laser/AuthoritativeProjectileField.ts').then(({ AuthoritativeProjectileField }) => AuthoritativeProjectileField.getInstance())"
    );
    const shotId = await shooter.fireLaserAtRemotePlayer(teammateId, 90);
    await expect
      .poll(
        () =>
          field.evaluate(
            (projectiles, { id, targetId }) => {
              const shot = projectiles.getProjectiles().find((row) => row.id === id);
              const target = window.gameController
                ?.getNetworkManager()
                .getAllPlayers()
                .find((player) => player.id === targetId);
              return Boolean(
                shot &&
                  target &&
                  shot.bounces === 0 &&
                  shot.position.x > target.ship.position.x + target.ship.r
              );
            },
            { id: shotId, targetId: teammateId }
          ),
        { timeout: 5000 }
      )
      .toBe(true);
    await field.dispose();

    expect(await teammate.getShipHealth()).toBe(beforeHealth);
    expect(await teammate.getShipHealth()).toBe(beforeLives);
    expect(await shooter.getScore()).toBe(beforeShooterScore);
    expect(await teammate.getScore()).toBe(beforeTeammateScore);
    expect(await shooter.getPlayerHealthById(teammateId)).toBe(beforeHealth);
    expect(await teammate.getPlayerHealthById(shooterId)).toBeGreaterThan(0);

    // Unbounced crew safety still applies to physical overlap. Put the live
    // shooter on the teammate through the server placement boundary, then let
    // the normal collision loop run without granting either pilot damage.
    const teammatePosition = await teammate.getShipPosition();
    await shooter.placeShipAt(teammatePosition.x, teammatePosition.y);
    const frame = (await getWorldDiagnostics()).gameTime;
    await expect
      .poll(async () => (await getWorldDiagnostics()).gameTime, { timeout: 5000 })
      .toBeGreaterThan(frame + 3);
    expect(await shooter.getShipHealth()).toBeGreaterThan(0);
    expect(await teammate.getShipHealth()).toBe(beforeHealth);
    expect(await teammate.getShipHealth()).toBe(beforeLives);
    expect(await shooter.getScore()).toBe(beforeShooterScore);
    expect(await teammate.getScore()).toBe(beforeTeammateScore);
    assertNoBrowserDiagnostics(shooterDiagnostics);
    assertNoBrowserDiagnostics(teammateDiagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
