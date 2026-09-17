import { expect, test } from 'vitest';
import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
const FIXTURE_ASTEROID_ID = 'crew-fixture-ore';

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])(
  'Hauler releases during cooldown and keeps firing after a delayed frame at $width pixels',
  async (viewport) => {
    const mobile = viewport.width < 600;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    const useAbility = () =>
      mobile ? page.locator('#touch-ability').tap() : page.keyboard.press('KeyE');
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const decoder = new SnapshotDecoder();
    const protocolErrors: string[] = [];
    const abilityTargets: unknown[] = [];
    const shotIds: unknown[] = [];
    let snapshot: ServerGameSnapshot | undefined;
    let snapshotCount = 0;
    page.on('websocket', (socket) => {
      if (!/\/ws(?:\?|$)/.test(socket.url())) {
        return;
      }
      socket.on('framereceived', ({ payload }) => {
        try {
          const result = decoder.readMessage(String(payload), { acceptSnapshots: true });
          if (result.kind === 'snapshot-rejected') {
            throw result.error;
          }
          if (result.kind === 'snapshot') {
            snapshot = result.state;
            snapshotCount++;
            return;
          }
          const message = result.message;
          if (!message || typeof message !== 'object' || !('type' in message)) {
            throw new Error('Gameplay packet omitted its type');
          }
          if (message.type === 'joined') {
            decoder.reset();
          }
          if ('data' in message && message.data && typeof message.data === 'object') {
            if (message.type === 'abilityUsed' && 'harpoonTargetId' in message.data) {
              abilityTargets.push(message.data.harpoonTargetId);
            }
            if (message.type === 'shotAcknowledged' && 'projectileId' in message.data) {
              shotIds.push(message.data.projectileId);
            }
          }
        } catch (error) {
          protocolErrors.push(String(error));
        }
      });
    });
    const game = new GameInteractions(page);
    await game.bootGame({
      kitId: 'hauler',
      haulerUtility: 'tow_cable',
      waitForCombatReady: false,
    });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'delivery');
    await page.waitForFunction(
      (asteroidId) => {
        const controller = window.gameController;
        const asteroid = controller
          ?.getCurrRoidBelt()
          .getRoids()
          .find((rock) => rock.id === asteroidId);
        return controller?.getCurrPlayer()?.ship.kitId === 'hauler' && asteroid?.health === 75;
      },
      FIXTURE_ASTEROID_ID,
      { timeout: 5000, polling: 50 }
    );

    const canvas = await page.locator('#gameCanvas').boundingBox();
    if (!canvas) {
      throw new Error('Game canvas unavailable');
    }
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height * 0.12);
    await useAbility();
    await expect
      .poll(
        () => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId),
        { timeout: 5000, message: 'Hauler E should attach the fixture asteroid' }
      )
      .toBe(FIXTURE_ASTEROID_ID);

    const atAttach = await page.evaluate((asteroidId) => {
      const asteroid = window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .find((rock) => rock.id === asteroidId);
      if (!asteroid) {
        throw new Error('Tow fixture disappeared at attachment');
      }
      return { x: asteroid.position.x, y: asteroid.position.y };
    }, FIXTURE_ASTEROID_ID);

    // Attachment preserves the rock's momentum. Turn away from it so the
    // persistent cable becomes taut before checking that towing moves cargo.
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height * 0.88);
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ asteroidId, beforeY }) => {
              const controller = window.gameController;
              const ship = controller?.getCurrPlayer()?.ship;
              const asteroid = controller
                ?.getCurrRoidBelt()
                .getRoids()
                .find((rock) => rock.id === asteroidId);
              return (
                ship?.harpoonTargetId === asteroidId &&
                asteroid !== undefined &&
                Math.abs(asteroid.position.y - beforeY) > 0.5
              );
            },
            { asteroidId: FIXTURE_ASTEROID_ID, beforeY: atAttach.y }
          ),
        {
          timeout: 5000,
          message: 'The taut tow cable should move the attached rock with the Hauler',
        }
      )
      .toBe(true);
    const duringTow = await page.evaluate((asteroidId) => {
      const controller = window.gameController;
      const ship = controller?.getCurrPlayer()?.ship;
      const asteroid = controller
        ?.getCurrRoidBelt()
        .getRoids()
        .find((rock) => rock.id === asteroidId);
      if (!ship || !asteroid) {
        throw new Error('Tow fixture disappeared before release');
      }
      return {
        towId: ship.harpoonTargetId,
        cooldown: ship.abilityCooldownFrames,
        asteroid: { x: asteroid.position.x, y: asteroid.position.y },
        hasRemovedTimer: 'harpoonTimer' in ship,
      };
    }, FIXTURE_ASTEROID_ID);
    expect(duringTow.towId).toBe(FIXTURE_ASTEROID_ID);
    expect(duringTow.cooldown).toBeGreaterThan(0);
    expect(abilityTargets).toEqual([FIXTURE_ASTEROID_ID]);
    expect(duringTow.hasRemovedTimer).toBe(false);
    if (mobile) {
      expect(await page.locator('#touch-ability').textContent()).toBe('RELEASE');
      expect(await page.locator('#touch-ability').getAttribute('aria-disabled')).toBe('false');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath('hauler-release-mobile.png'),
      });
    }
    expect(duringTow.asteroid.y).not.toBe(atAttach.y);

    await useAbility();
    await expect.poll(() => abilityTargets).toEqual([FIXTURE_ASTEROID_ID, null]);
    await expect
      .poll(
        () => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId),
        {
          timeout: 5000,
          message: 'Hauler E should release the tow cable',
        }
      )
      .toBeNull();
    const releasedAt = snapshotCount;
    await expect.poll(() => snapshotCount).toBeGreaterThan(releasedAt + 5);
    expect(snapshot?.entities.find((entity) => entity.id === playerId)?.harpoonTargetId).toBeNull();
    expect(
      await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId)
    ).toBeNull();

    // Use the actual render loop after a main-thread stall, then verify that a
    // shot survives acknowledgement and subsequent authoritative snapshots.
    await arrangeCrewField([playerId], 'empty');
    await game.placeShipAt(0, -360);
    await game.waitForCombatReady();
    await page.evaluate(() => {
      const until = performance.now() + 250;
      while (performance.now() < until) {
        // Deliberately delay a frame; do not replace the game's simulation.
      }
    });
    await game.waitForAnimationFrames(2);
    await page.keyboard.press('Space');
    await expect.poll(() => shotIds.length).toBe(1);
    const shotId = shotIds[0];
    expect(shotId).toEqual(expect.any(String));
    const firedAt = snapshotCount;
    await expect.poll(() => snapshotCount).toBeGreaterThan(firedAt + 3);
    expect(snapshot?.playerProjectiles.some((shot) => shot.id === shotId)).toBe(true);
    expect(
      await page.evaluate(
        (id) =>
          window.gameController
            ?.getCurrPlayer()
            ?.ship.lasers.some((laser) => laser.serverId === id && !laser.hasExploded),
        shotId
      )
    ).toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`hauler-tow-${viewport.width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
    expect(protocolErrors).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
