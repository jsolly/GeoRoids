import { expect, test } from 'vitest';
import type { AuthoritativeProjectileField } from '../../../../src/entities/laser/AuthoritativeProjectileField';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

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
    await page.waitForFunction(() =>
      window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .some((rock) => rock.phenomenon?.kind === 'reflective')
    );
    const pocket = await page.evaluate(() => {
      const rocks = window.gameController?.getCurrRoidBelt().getRoids() ?? [];
      const groups = new Map<string, typeof rocks>();
      for (const rock of rocks) {
        if (rock.phenomenon?.kind !== 'reflective') {
          continue;
        }
        const group = groups.get(rock.phenomenon.clusterId) ?? [];
        group.push(rock);
        groups.set(rock.phenomenon.clusterId, group);
      }
      const group = [...groups.values()]
        .filter((members) => members.length === 3)
        .sort(
          (a, b) =>
            Math.hypot(a[0]?.position.x ?? Infinity, a[0]?.position.y ?? Infinity) -
            Math.hypot(b[0]?.position.x ?? Infinity, b[0]?.position.y ?? Infinity)
        )[0];
      if (!group) {
        throw new Error('No intact reflective pocket');
      }
      return {
        x: group.reduce((sum, rock) => sum + rock.position.x, 0) / 3,
        y: group.reduce((sum, rock) => sum + rock.position.y, 0) / 3,
      };
    });
    // Match the external inward-facet lane covered by the cluster physics test.
    // Face down that lane before placement so automatic cruise cannot shift the
    // launch sideways while the fixture snapshot arrives.
    const approachAngle = (Math.PI * 3) / 10;
    await page.evaluate((angle) => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local pilot missing');
      }
      ship.angle = Math.PI - angle;
    }, approachAngle);
    await game.placeShipAt(
      pocket.x + Math.cos(approachAngle) * 300,
      pocket.y + Math.sin(approachAngle) * 300
    );
    await game.armSpawnProtection();
    const field = await page.evaluateHandle<AuthoritativeProjectileField>(
      "import('/src/entities/laser/AuthoritativeProjectileField.ts').then(({ AuthoritativeProjectileField }) => AuthoritativeProjectileField.getInstance())"
    );
    const proof = await page.evaluateHandle((projectiles) => {
      const evidence = { bounces: 0, timer: 0 };
      evidence.timer = window.setInterval(() => {
        const owner = window.gameController?.getCurrPlayer()?.id;
        for (const shot of projectiles.getProjectiles()) {
          if (shot.ownerId === owner) {
            evidence.bounces = Math.max(evidence.bounces, shot.bounces);
          }
        }
      }, 10);
      return evidence;
    }, field);
    try {
      await game.fireLaserToward(pocket.x, pocket.y);
      await expect
        .poll(() => proof.evaluate((evidence) => evidence.bounces), { timeout: 5000 })
        .toBeGreaterThanOrEqual(3);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`pinball-pocket-${viewport.width}.png`),
      });
      assertNoBrowserDiagnostics(diagnostics);
    } finally {
      await proof.evaluate((evidence) => window.clearInterval(evidence.timer));
      await proof.dispose();
      await field.dispose();
    }
  }
);
