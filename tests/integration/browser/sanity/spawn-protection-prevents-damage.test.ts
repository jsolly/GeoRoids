import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField, placePlayer } from '../../utils/test-server-control';

const { browserManager } = createBrowserScenarioHooks();

test(
  'spawn protection blocks an environmental asteroid impact until the timer expires',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);

    await game.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'delivery');
    await page.waitForFunction(() =>
      window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .some((candidate) => candidate.id === 'crew-fixture-ore')
    );
    const rock = (await game.getAsteroidPositions()).find(
      (candidate) => candidate.id === 'crew-fixture-ore'
    );
    if (!rock) {
      throw new Error('Environmental collision fixture missing');
    }
    await game.placeShipAt(rock.x, rock.y + 100);
    await game.waitForServerSpawnProtection();

    const protectedHealth = await game.getShipHealth();
    const placement = await placePlayer(playerId, { x: rock.x, y: rock.y });
    await page.waitForFunction(
      (motionEpoch) =>
        window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship.playerMotion?.epoch ===
        motionEpoch,
      placement.motionEpoch,
      { timeout: 5000, polling: 25 }
    );
    await page.evaluate(
      (position) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!ship) {
          throw new Error('Local ship unavailable after environmental placement');
        }
        // Keep the client prediction aligned with the authoritative fixture
        // without clearing its server-owned protection timer.
        ship.position = position;
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = false;
        ship.angularVelocity = 0;
      },
      { x: rock.x, y: rock.y }
    );

    await page.waitForTimeout(500);
    expect(await game.getShipHealth()).toBe(protectedHealth);
    expect(await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.exploding)).toBe(
      false
    );

    expect(
      (await game.getAsteroidPositions()).some((candidate) => candidate.id === 'crew-fixture-ore')
    ).toBe(true);
    await game.waitForCombatReady();
    await game.placeShipAt(rock.x, rock.y);
    await expect
      .poll(() => game.getShipHealth(), {
        timeout: 15000,
        message: 'the same environmental impact should apply after protection expires',
      })
      .toBe(protectedHealth - 25);
    expect(await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.exploding)).toBe(
      false
    );
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
