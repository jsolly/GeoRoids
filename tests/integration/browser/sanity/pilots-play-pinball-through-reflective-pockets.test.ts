import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { AuthoritativeProjectileField } from '../../../../src/entities/laser/AuthoritativeProjectileField';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { withScenarioCleanup } from '../../utils/scenario-cleanup';
import { arrangeCrewField, getFixtureState } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])(
  'a pilot sends one shot through multiple reflective bumpers at $width pixels',
  async (viewport) => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.width < 600 });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    const id = await game.getLocalPlayerId();
    const epochs = await arrangeCrewField([id], 'pinball');
    await game.waitForControlledFixture(epochs.get(id));
    const pocket = {
      x: 0,
      y: -1500,
      ids: [0, 1, 2].map((index) => `crew-fixture-pinball-${index}`),
    };
    await expect
      .poll(async () =>
        (await game.getAsteroidPositions())
          .map((rock) => rock.id)
          .sort((a, b) => a.localeCompare(b))
      )
      .toEqual(pocket.ids);
    const field = await page.evaluateHandle<AuthoritativeProjectileField>(
      "import('/src/entities/laser/AuthoritativeProjectileField.ts').then(({ AuthoritativeProjectileField }) => AuthoritativeProjectileField.getInstance())"
    );
    const proof = await page.evaluateHandle((projectiles) => {
      const acknowledgements: { requestId: string; projectileId: string | null }[] = [];
      const original = projectiles.acknowledgeShot.bind(projectiles);
      projectiles.acknowledgeShot = (ack) => {
        acknowledgements.push({ ...ack });
        original(ack);
      };
      const evidence = {
        bounces: 0,
        timer: 0,
        acknowledgements,
        restore: () => {
          projectiles.acknowledgeShot = original;
        },
      };
      evidence.timer = window.setInterval(() => {
        const owner = window.gameController?.getCurrPlayer()?.id;
        for (const shot of projectiles.getProjectiles()) {
          if (
            shot.ownerId === owner &&
            evidence.acknowledgements.some((ack) => ack.projectileId === shot.id)
          ) {
            evidence.bounces = Math.max(evidence.bounces, shot.bounces);
          }
        }
      }, 10);
      return evidence;
    }, field);
    await withScenarioCleanup(
      async () => {
        const approachAngle = (Math.PI * 3) / 10;
        const launchPosition = {
          x: pocket.x + Math.cos(approachAngle) * 300,
          y: pocket.y + Math.sin(approachAngle) * 300,
        };
        await game.placeControlledShipAt(launchPosition.x, launchPosition.y);
        // Cruise can add lateral terrain velocity between browser round trips.
        // Align the fixture and fire in one task, through the normal shoot path.
        const launch = await page.evaluate(
          ({ position, angle }) => {
            const ship = window.gameController?.getCurrPlayer()?.ship;
            if (!ship) {
              throw new Error('Local pilot missing');
            }
            ship.position = position;
            ship.velocity = { x: 0, y: 0 };
            ship.angularVelocity = 0;
            ship.angle = Math.PI - angle;
            ship.blinkCount = 600;
            ship.spawnProtectionTimer = 600;
            ship.canShoot = true;
            ship.shoot();
            const shot = ship.lasers.at(-1);
            if (!shot) {
              throw new Error('Pinball fixture did not fire its shot');
            }
            return { position: shot.position, velocity: shot.velocity };
          },
          { position: launchPosition, angle: approachAngle }
        );
        const server = await getFixtureState(pocket.ids);
        writeFileSync(
          screenshotManager.getScreenshotPath(`pinball-launch-${viewport.width}.json`),
          JSON.stringify({ pocket, launchPosition, launch, server }, null, 2)
        );
        await expect
          .poll(() => proof.evaluate((evidence) => evidence.bounces), { timeout: 5000 })
          .toBeGreaterThanOrEqual(3);
        await page.screenshot({
          path: screenshotManager.getScreenshotPath(`pinball-pocket-${viewport.width}.png`),
        });
        assertNoBrowserDiagnostics(diagnostics);
      },
      () => [
        async () => {
          const result = await proof.evaluate((evidence) => ({
            bounces: evidence.bounces,
            acknowledgements: evidence.acknowledgements,
          }));
          writeFileSync(
            screenshotManager.getScreenshotPath(`pinball-result-${viewport.width}.json`),
            JSON.stringify(result, null, 2)
          );
        },
        () =>
          proof.evaluate((evidence) => {
            window.clearInterval(evidence.timer);
            evidence.restore();
          }),
        () => proof.dispose(),
        () => field.dispose(),
      ]
    );
  }
);
