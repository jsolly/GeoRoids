import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { SHIP } from '../../../../src/constants';
import type { AuthoritativeProjectileField } from '../../../../src/entities/laser/AuthoritativeProjectileField';
import { watchBrowserDiagnostics } from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
const REFLECTOR_ID = 'crew-fixture-reflector';
const REFLECTOR_POSITION = { x: 0, y: -460 };
const FIRING_POSITION = { x: -220, y: -460 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

declare global {
  interface Window {
    __reflectionProof?: {
      shots: Record<string, { energy: number; bounces: number }>;
      timer: number;
    };
  }
}

async function ensureAlive(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ship = window.gameController?.getCurrPlayer()?.ship;
    if (!ship || ship.health <= 0 || ship.exploding) {
      throw new Error('Pilot died during reflection flight');
    }
  });
}

async function readReflector(
  page: Page
): Promise<{ energy: number; exists: true } | { exists: false }> {
  return await page.evaluate((id) => {
    const rock = window.gameController
      ?.getCurrRoidBelt()
      .getRoids()
      .find((candidate) => candidate.id === id);
    if (!rock) {
      return { exists: false };
    }
    if (rock.phenomenon?.kind !== 'reflective') {
      throw new Error('Reflection fixture lost its reflective phenomenon');
    }
    return { exists: true, energy: rock.phenomenon.energy };
  }, REFLECTOR_ID);
}

async function waitForShotReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((maxLasers) => {
          const ship = window.gameController?.getCurrPlayer()?.ship;
          return Boolean(
            ship &&
              ship.lasers.length < maxLasers &&
              Date.now() - ship.lastShotTime >= ship.shotCooldown
          );
        }, SHIP.MAX_LASERS),
      { timeout: 5000, message: 'Normal firing cooldown/projectile capacity did not recover' }
    )
    .toBe(true);
}

async function fireAt(game: GameInteractions, page: Page): Promise<void> {
  await ensureAlive(page);
  await waitForShotReady(page);
  await game.fireLaserToward(REFLECTOR_POSITION.x, REFLECTOR_POSITION.y);
}

test(
  'reflective shots bounce, break for one core, and grant six visible upgraded shots',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    const consoleState = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    let destroyedOrigin: { x: number; y: number } | undefined;
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const message: unknown = JSON.parse(String(payload));
        if (isRecord(message) && message['type'] === 'asteroidDestroy') {
          const data = message['data'];
          const origin = isRecord(data) ? data['origin'] : undefined;
          if (
            isRecord(data) &&
            data['asteroidId'] === REFLECTOR_ID &&
            isRecord(origin) &&
            typeof origin['x'] === 'number' &&
            typeof origin['y'] === 'number'
          ) {
            destroyedOrigin = { x: origin['x'], y: origin['y'] };
          }
        }
      })
    );

    await page.setViewportSize({ width: 1280, height: 900 });
    await game.bootGame({ waitForCombatReady: false, kitId: 'hauler' });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'reflection');
    // Keep the real client and server poses aligned after the diagnostic
    // arrangement. The fixture has no bots or other hazards to navigate.
    await game.placeShipAt(FIRING_POSITION.x, FIRING_POSITION.y);
    await expect
      .poll(() => readReflector(page), { timeout: 5000 })
      .toEqual({ exists: true, energy: 0 });

    const field = await page.evaluateHandle<AuthoritativeProjectileField>(
      "import('/src/entities/laser/AuthoritativeProjectileField.ts').then(({ AuthoritativeProjectileField }) => AuthoritativeProjectileField.getInstance())"
    );
    try {
      await page.evaluate((projectiles) => {
        const id = window.gameController?.getCurrPlayer()?.id;
        if (!id) {
          throw new Error('Reflection observer requires a joined pilot');
        }
        const evidence: NonNullable<Window['__reflectionProof']> = { shots: {}, timer: 0 };
        window.__reflectionProof = evidence;
        evidence.timer = window.setInterval(() => {
          for (const row of projectiles.getProjectiles()) {
            if (row.ownerId !== id) {
              continue;
            }
            const previous = evidence.shots[row.id];
            evidence.shots[row.id] = {
              energy: Math.max(previous?.energy ?? 0, row.energy),
              bounces: Math.max(previous?.bounces ?? 0, row.bounces),
            };
          }
        }, 10);
      }, field);
    } finally {
      await field.dispose();
    }

    try {
      const previousCores = new Set((await game.getLoot()).map((drop) => drop.id));
      for (let shot = 0; shot < 6; shot++) {
        const before = await readReflector(page);
        if (!before.exists) {
          throw new Error(`Reflector disappeared before shot ${shot + 1}`);
        }
        // Keep each shot's approach outside the hull; automatic cruise must
        // not replace the sixth laser hit with a ship collision.
        await game.placeShipAt(FIRING_POSITION.x, FIRING_POSITION.y);
        await fireAt(game, page);
        await expect
          .poll(
            async () => {
              const after = await readReflector(page);
              return !after.exists || after.energy > before.energy;
            },
            {
              timeout: 5000,
              message: `reflective shot ${shot + 1} did not reach the fixture rock`,
            }
          )
          .toBe(true);
      }

      await expect.poll(() => readReflector(page), { timeout: 5000 }).toEqual({ exists: false });
      const reflectedShots = await page.evaluate(() => {
        const evidence = window.__reflectionProof;
        if (!evidence) {
          throw new Error('Reflection observer unavailable');
        }
        return Object.values(evidence.shots);
      });
      expect(reflectedShots.some((shot) => shot.bounces > 0 && shot.energy > 1)).toBe(true);

      await expect.poll(() => destroyedOrigin, { timeout: 5000 }).toBeDefined();
      if (!destroyedOrigin) {
        throw new Error('Reflector destruction did not identify its live position');
      }
      const origin = destroyedOrigin;
      let core: Awaited<ReturnType<GameInteractions['getLoot']>>[number] | undefined;
      await expect
        .poll(
          async () => {
            core = (await game.getLoot()).find(
              (drop) =>
                drop.kind === 'laserCore' &&
                !previousCores.has(drop.id) &&
                Math.hypot(drop.x - origin.x, drop.y - origin.y) < 60
            );
            return core;
          },
          { timeout: 5000, message: 'The selected reflector yields one physical core' }
        )
        .toBeDefined();
      assert.ok(core, 'Selected reflector did not drop its core');

      await game.placeShipAt(core.x, core.y);
      await expect
        .poll(
          () =>
            page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.laserUpgrade?.charges),
          { timeout: 5000, message: 'collecting the core should grant six charges' }
        )
        .toBe(6);
      await expect
        .poll(async () => (await game.getLoot()).some((drop) => drop.id === core?.id), {
          timeout: 5000,
        })
        .toBe(false);

      await game.placeShipAt(FIRING_POSITION.x, FIRING_POSITION.y);
      const beforeUpgraded = await page.evaluate(() => {
        const evidence = window.__reflectionProof;
        if (!evidence) {
          throw new Error('Reflection observer unavailable');
        }
        return Object.keys(evidence.shots);
      });
      for (let shot = 0; shot < 6; shot++) {
        await fireAt(game, page);
        await expect
          .poll(
            () =>
              page.evaluate(
                () => window.gameController?.getCurrPlayer()?.ship.laserUpgrade?.charges ?? 0
              ),
            { timeout: 3000, message: `upgraded shot ${shot + 1} did not consume one charge` }
          )
          .toBe(5 - shot);
      }
      const proof = await page.evaluate(() => {
        const evidence = window.__reflectionProof;
        if (!evidence) {
          throw new Error('Reflection observer unavailable');
        }
        return evidence.shots;
      });
      expect(
        Object.entries(proof).filter(([id, row]) => !beforeUpgraded.includes(id) && row.energy >= 2)
      ).toHaveLength(6);
      expect(consoleState.errors).toEqual([]);
      expect(consoleState.warnings).toEqual([]);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath('reflective-core-upgrade-desktop.png'),
      });
      writeFileSync(
        screenshotManager.getScreenshotPath('reflective-core-upgrade-desktop.json'),
        `${JSON.stringify({ reflectorId: REFLECTOR_ID, coreId: core.id, shots: proof }, null, 2)}\n`
      );
    } catch (error) {
      const diagnostic = await page.evaluate((id) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('Game controller unavailable');
        }
        const ship = gc.getCurrPlayer()?.ship;
        if (!ship) {
          throw new Error('Local ship unavailable');
        }
        return {
          ship: { position: ship.position, velocity: ship.velocity, health: ship.health },
          laserUpgrade: ship.laserUpgrade,
          loot: gc.getLoot(),
          target: gc
            .getCurrRoidBelt()
            .getRoids()
            .find((row) => row.id === id),
          observed: window.__reflectionProof?.shots,
        };
      }, REFLECTOR_ID);
      writeFileSync(
        screenshotManager.getScreenshotPath('reflective-failure.json'),
        `${JSON.stringify({ error: String(error), destroyedOrigin, ...diagnostic }, null, 2)}\n`
      );
      await page.screenshot({
        path: screenshotManager.getScreenshotPath('reflective-failure.png'),
      });
      throw error;
    } finally {
      await page.evaluate(() => {
        window.clearInterval(window.__reflectionProof?.timer);
        delete window.__reflectionProof;
      });
    }
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
