import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { GAME, LASER, SHIP } from '../../../../src/constants';
import {
  captureConsole,
  safestReflectiveCluster,
  waitForEnhancedTargets,
} from '../../utils/asteroid-tools-driver';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
type Point = { x: number; y: number };

async function defend(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const ship = (window as any).gameController?.playerManager?.getLocalPlayer?.()?.ship;
    if (!ship || ship.health <= 0 || ship.exploding) {
      throw new Error('Pilot died during reflection flight');
    }
    return {
      cooldown: ship.abilityCooldownFrames,
      shield: ship.shieldActive,
      shieldCooldown: ship.shieldCooldown,
    };
  });
  // Warden E can refresh after its real cooldown, before the old absorb timer
  // expires. F independently blocks lasers. Neither path writes health/timers.
  if (state.cooldown <= 0) {
    await page.keyboard.press('e');
  }
  if (!state.shield && state.shieldCooldown <= 0) {
    await page.keyboard.press('f');
  }
}

async function flyTo(page: Page, target: Point, tolerance = 25, timeout = 25_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let thrustHeld = false;
  try {
    while (Date.now() < deadline) {
      await defend(page);
      const steering = await page.evaluate(
        ({ target, tolerance }) => {
          const ship = (window as any).gameController.playerManager.getLocalPlayer().ship;
          const dx = target.x - ship.position.x;
          const dy = target.y - ship.position.y;
          const distance = Math.hypot(dx, dy);
          const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
          if (distance <= tolerance && speed < 0.65) {
            return { arrived: true, thrust: false };
          }
          // Aim the real thruster against excess velocity before reaching the
          // destination. Releasing W alone preserves momentum and hits the rock.
          const desiredSpeed = Math.min(
            ship.maxVelocity * 0.65,
            Math.max(0, distance - tolerance / 2) * 0.035
          );
          const ax = (dx / Math.max(distance, 1)) * desiredSpeed - ship.velocity.x;
          const ay = (dy / Math.max(distance, 1)) * desiredSpeed - ship.velocity.y;
          ship.angle = Math.atan2(-ay, ax);
          return { arrived: false, thrust: Math.hypot(ax, ay) > 0.1 };
        },
        { target, tolerance }
      );
      if (steering.thrust !== thrustHeld) {
        if (steering.thrust) {
          await page.keyboard.down('KeyW');
        } else {
          await page.keyboard.up('KeyW');
        }
        thrustHeld = steering.thrust;
      }
      if (steering.arrived) {
        return;
      }
      await page.waitForTimeout(50);
    }
    throw new Error(
      `Pilot did not reach (${Math.round(target.x)}, ${Math.round(target.y)}) with controlled momentum`
    );
  } finally {
    await page.keyboard.up('KeyW');
  }
}

async function fireAt(
  page: Page,
  target: Point,
  station: Point,
  asteroidId?: string
): Promise<void> {
  await flyTo(page, station, 18, 10_000);
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    await defend(page);
    ready = await page.evaluate((maxLasers) => {
      const ship = (window as any).gameController.playerManager.getLocalPlayer().ship;
      return ship.lasers.length < maxLasers && Date.now() - ship.lastShotTime >= ship.shotCooldown;
    }, SHIP.MAX_LASERS);
    if (ready) {
      break;
    }
    await flyTo(page, station, 18, 5000);
    await page.waitForTimeout(50);
  }
  if (!ready) {
    throw new Error('Normal firing cooldown/projectile capacity did not recover');
  }
  const priorEnergy = asteroidId
    ? await page.evaluate((id) => {
        const rock = (window as any).gameController
          .getCurrRoidBelt()
          .getRoids()
          .find((row: any) => row.id === id);
        return rock?.phenomenon?.energy ?? null;
      }, asteroidId)
    : null;
  // Never fire a queued follow-up through a just-dropped core.
  if (asteroidId && priorEnergy === null) {
    return;
  }
  await page.evaluate(
    ({ point, laserSpeed }) => {
      const ship = (window as any).gameController.playerManager.getLocalPlayer().ship;
      const dx = point.x - ship.position.x;
      const dy = point.y - ship.position.y;
      const vx = ship.velocity.x;
      const vy = ship.velocity.y;
      const a = vx * vx + vy * vy - laserSpeed * laserSpeed;
      const b = -2 * (dx * vx + dy * vy);
      const c = dx * dx + dy * dy;
      const discriminant = b * b - 4 * a * c;
      const roots =
        Math.abs(a) < 1e-9
          ? [-c / b]
          : discriminant >= 0
            ? [(-b + Math.sqrt(discriminant)) / (2 * a), (-b - Math.sqrt(discriminant)) / (2 * a)]
            : [];
      const time = roots
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((x, y) => x - y)[0];
      ship.angle = time ? Math.atan2(-(dy / time - vy), dx / time - vx) : Math.atan2(-dy, dx);
      // Return focus to the game before Space; no direct shoot/cooldown mutation.
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    },
    { point: target, laserSpeed: LASER.SPEED / GAME.FPS }
  );
  await page.keyboard.press('Space');
  if (asteroidId) {
    // Wait out the physical flight, defending through real input. A bot may
    // intercept a valid shot; that is ordinary combat, so the next aimed shot
    // can continue rather than assuming every shot reaches the same asteroid.
    const until = Date.now() + 850;
    while (Date.now() < until) {
      await defend(page);
      const reached = await page.evaluate(
        ({ id, energy }) => {
          const rock = (window as any).gameController
            .getCurrRoidBelt()
            .getRoids()
            .find((row: any) => row.id === id);
          return !rock || rock.phenomenon.energy > energy;
        },
        { id: asteroidId, energy: priorEnergy }
      );
      if (reached) {
        break;
      }
      await page.waitForTimeout(50);
    }
  }
  await page.waitForTimeout(310); // Normal cooldown, with RAF/server progressing in wall time.
}

test(
  'reflective shots bounce, break for one core, and grant six visible upgraded shots',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    let selectedId = '';
    let destroyedOrigin: Point | undefined;
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === 'asteroidDestroy' && message.data?.asteroidId === selectedId) {
          destroyedOrigin = message.data.origin;
        }
      })
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    const consoleState = captureConsole(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'warden' });
    await waitForEnhancedTargets(page);
    await game.waitForBots(2);
    await defend(page);
    const reflective = await page.evaluate(() => {
      const gc = (window as any).gameController;
      const state = gc.getAsteroidToolsController().getState();
      const ship = gc.playerManager.getLocalPlayer().ship;
      const rocks = gc.getCurrRoidBelt().getRoids();
      const targets = state.targets.filter((target: { id: string }) => {
        const rock = rocks.find((candidate: { id: string }) => candidate.id === target.id);
        return rock && rock.health === rock.maxHealth;
      });
      const hazards = gc
        .getNetworkManager()
        .getAllPlayers()
        .filter((player: { type: string }) => player.type === 'bot')
        .map((player: { ship: { position: Point } }) => ({ ...player.ship.position }));
      return { ship: { ...ship.position }, targets, hazards };
    });
    const cluster = safestReflectiveCluster(reflective.targets, reflective.hazards);
    expect(cluster.length).toBeGreaterThanOrEqual(2);
    const primary = [...cluster].sort(
      (a, b) =>
        Math.hypot(a.position.x - reflective.ship.x, a.position.y - reflective.ship.y) -
        Math.hypot(b.position.x - reflective.ship.x, b.position.y - reflective.ship.y)
    )[0];
    if (!primary) {
      throw new Error('No physical reflective cluster');
    }
    selectedId = primary.id;
    const partner = cluster.find((candidate) => candidate.id !== primary.id)!;
    // Fire from the outer face so the partner cannot intercept the aimed shot.
    const offset = {
      x: primary.position.x - partner.position.x,
      y: primary.position.y - partner.position.y,
    };
    const length = Math.hypot(offset.x, offset.y) || 1;
    const firingDistance = primary.size + (await game.getShipRadius()) + 40;
    const station = {
      x: primary.position.x + (offset.x / length) * firingDistance,
      y: primary.position.y + (offset.y / length) * firingDistance,
    };
    await game.placeShipAt(station.x, station.y);
    const previousCores = new Set((await game.getLoot()).map((drop) => drop.id));

    // This observer only records the actual decoded/rendered projectile field.
    // It starts before firing and survives short-lived reflected snapshot rows.
    await page.evaluate(`(async () => {
      const modulePath = '/src/entities/laser/AuthoritativeProjectileField.ts';
      const { AuthoritativeProjectileField } = await import(modulePath);
      const evidence = {
        shots: {},
        timer: 0,
      };
      window.__reflectionProof = evidence;
      evidence.timer = window.setInterval(() => {
        const id = window.gameController.playerManager.getLocalPlayer().id;
        for (const row of AuthoritativeProjectileField.getInstance().getProjectiles()) {
          if (row.ownerId !== id) continue;
          const previous = evidence.shots[row.id];
          evidence.shots[row.id] = {
            energy: Math.max(previous?.energy ?? 0, row.energy),
            bounces: Math.max(previous?.bounces ?? 0, row.bounces),
          };
        }
      }, 10);
    })()`);
    try {
      await page.locator('#asteroid-tools-launcher').click();
      await page.locator('[data-asteroid-tools-target]').selectOption(primary.id);
      await page.evaluate((point) => {
        const ship = (window as any).gameController.playerManager.getLocalPlayer().ship;
        ship.angle = Math.atan2(-(point.y - ship.position.y), point.x - ship.position.x);
      }, primary.position);
      await expect
        .poll(() => page.locator('.asteroid-tools-overlay__preview').isVisible(), { timeout: 5000 })
        .toBe(true);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath('reflective-aim-preview-desktop.png'),
      });
      await page.locator('[data-asteroid-tools-action="close"]').click();

      for (let shot = 0; shot < 16; shot++) {
        const target = await page.evaluate((id) => {
          const rock = (window as any).gameController
            .getCurrRoidBelt()
            .getRoids()
            .find((row: any) => row.id === id);
          return rock ? { ...rock.position } : null;
        }, primary.id);
        if (!target) {
          break;
        }
        await fireAt(page, target, station, primary.id);
      }
      await expect
        .poll(
          () =>
            page.evaluate(
              (id) =>
                !(window as any).gameController
                  .getCurrRoidBelt()
                  .getRoids()
                  .some((row: any) => row.id === id),
              primary.id
            ),
          { timeout: 5000, message: 'Real shots must finish the selected reflective rock' }
        )
        .toBe(true);
      const reflectedShots = await page.evaluate(
        () =>
          Object.values((window as any).__reflectionProof.shots) as Array<{
            energy: number;
            bounces: number;
          }>
      );
      expect(reflectedShots.some((shot) => shot.bounces > 0 && shot.energy > 1)).toBe(true);

      await expect.poll(() => destroyedOrigin, { timeout: 5000 }).toBeDefined();
      if (!destroyedOrigin) {
        throw new Error('Reflector destruction did not identify its live position');
      }
      const origin = destroyedOrigin;
      let nearbyCores: Awaited<ReturnType<GameInteractions['getLoot']>> = [];
      // Destruction arrives as an immediate event; loot arrives in the next snapshot.
      await expect
        .poll(
          async () => {
            nearbyCores = (await game.getLoot()).filter(
              (drop) =>
                drop.kind === 'laserCore' &&
                !previousCores.has(drop.id) &&
                Math.hypot(drop.x - origin.x, drop.y - origin.y) < 60
            );
            return nearbyCores;
          },
          { timeout: 5000, message: 'The selected reflector yields one physical core' }
        )
        .toHaveLength(1);
      const core = nearbyCores[0]!;
      // Place the live pilot on this exact drop; the server still performs the
      // overlap pickup. Travel through the remaining belt is a separate scenario.
      await game.placeShipAt(core.x, core.y);
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as any).gameController.getAsteroidToolsController().getState().pilot
                  ?.laserUpgrade?.charges
            ),
          { timeout: 5000 }
        )
        .toBe(6);
      await expect
        .poll(async () => (await game.getLoot()).some((drop) => drop.id === core.id))
        .toBe(false);
      const upgradeStation = { x: -1800, y: -1800 };
      await game.placeShipAt(upgradeStation.x, upgradeStation.y);
      await page.locator('#asteroid-tools-launcher').click();
      expect(await page.locator('.asteroid-tools-overlay__upgrade').textContent()).toContain(
        '6 charges'
      );
      await page.screenshot({
        path: screenshotManager.getScreenshotPath('reflective-core-upgrade-desktop.png'),
      });
      await page.locator('[data-asteroid-tools-action="close"]').click();
      const beforeUpgraded = await page.evaluate(() =>
        Object.keys((window as any).__reflectionProof.shots)
      );
      const aim = { x: upgradeStation.x - 500, y: upgradeStation.y };
      for (let shot = 0; shot < 6; shot++) {
        await fireAt(page, aim, upgradeStation);
        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  (window as any).gameController.getAsteroidToolsController().getState().pilot
                    ?.laserUpgrade?.charges ?? 0
              ),
            { timeout: 3000 }
          )
          .toBe(5 - shot);
      }
      const proof = await page.evaluate(
        () =>
          (window as any).__reflectionProof.shots as Record<
            string,
            { energy: number; bounces: number }
          >
      );
      expect(
        Object.entries(proof).filter(([id, row]) => !beforeUpgraded.includes(id) && row.energy >= 2)
      ).toHaveLength(6);
      writeFileSync(
        screenshotManager.getScreenshotPath('reflective-core-upgrade-desktop.json'),
        `${JSON.stringify({ primaryId: primary.id, coreId: core.id, shots: proof, consoleState }, null, 2)}\n`
      );
      expect(consoleState.errors).toEqual([]);
      expect(consoleState.warnings).toEqual([]);
    } catch (error) {
      const diagnostic = await page.evaluate((id) => {
        const gc = (window as any).gameController;
        const ship = gc.playerManager.getLocalPlayer().ship;
        return {
          ship: {
            position: ship.position,
            velocity: ship.velocity,
            health: ship.health,
            shieldTimer: ship.shieldTimer,
          },
          serverPilot: gc.getAsteroidToolsController().getState().pilot,
          loot: gc.getLoot(),
          target: gc
            .getCurrRoidBelt()
            .getRoids()
            .find((row: any) => row.id === id),
          observed: (window as any).__reflectionProof?.shots,
        };
      }, primary.id);
      writeFileSync(
        screenshotManager.getScreenshotPath('reflective-failure.json'),
        `${JSON.stringify({ primary, destroyedOrigin, station, ...diagnostic }, null, 2)}\n`
      );
      await page.screenshot({
        path: screenshotManager.getScreenshotPath('reflective-failure.png'),
      });
      throw error;
    } finally {
      await page.evaluate(() => {
        window.clearInterval((window as any).__reflectionProof?.timer);
        delete (window as any).__reflectionProof;
      });
    }
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
