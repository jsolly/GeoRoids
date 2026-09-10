import { expect, test } from 'vitest';
import { captureConsole, waitForEnhancedTargets } from '../../utils/asteroid-tools-driver';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test(
  'Hauler touch controls latch, anchor a second rock, brake, spin, and release with bounded tangent motion',
  async () => {
    await browserManager.recreatePage({ hasTouch: true });
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const consoleState = captureConsole(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'hauler' });
    await waitForEnhancedTargets(page);
    await game.waitForBots(2);

    const fixture = await page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const state = gc?.getAsteroidToolsController?.()?.getState?.();
      const ship = gc?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      const rocks = gc?.getCurrRoidBelt?.()?.getRoids?.() ?? [];
      const rocksById = new Map(rocks.map((rock) => [rock.id, rock]));
      const bots = (gc?.getNetworkManager?.().getAllPlayers?.() ?? [])
        .filter((player) => player.type === 'bot' && player.ship?.health > 0)
        .map((player) => player.ship.position);
      const targets = (state?.targets ?? []).filter(
        (target) => target.phenomenon?.kind === 'reflective' && target.phenomenon.clusterId
      );
      const groups = new Map<string, (typeof targets)[number][]>();
      for (const target of targets) {
        const clusterId = target.phenomenon?.clusterId;
        if (!clusterId) {
          continue;
        }
        const group = groups.get(clusterId) ?? [];
        group.push(target);
        groups.set(clusterId, group);
      }
      if (!ship || bots.length < 2) {
        throw new Error('Enhanced field did not expose the live Hauler and both hostile bots');
      }

      const pairs: Array<{
        primary: (typeof rocks)[number];
        payload: (typeof rocks)[number];
        threatClearance: number;
      }> = [];
      for (const group of groups.values()) {
        for (const primaryTarget of group) {
          for (const payloadTarget of group) {
            if (primaryTarget.id === payloadTarget.id) {
              continue;
            }
            const primary = rocksById.get(primaryTarget.id);
            const payload = rocksById.get(payloadTarget.id);
            if (
              !primary ||
              !payload ||
              primary.health !== primary.maxHealth ||
              payload.health !== payload.maxHealth
            ) {
              continue;
            }
            const separation = Math.hypot(
              payload.position.x - primary.position.x,
              payload.position.y - primary.position.y
            );
            if (separation <= primary.r + payload.r + 4 || separation > 400) {
              continue;
            }
            const threatClearance = Math.min(
              ...bots.flatMap((position) => [
                Math.hypot(primary.position.x - position.x, primary.position.y - position.y),
                Math.hypot(payload.position.x - position.x, payload.position.y - position.y),
              ])
            );
            pairs.push({ primary, payload, threatClearance });
          }
        }
      }
      const pair = pairs.sort((a, b) => b.threatClearance - a.threatClearance)[0];
      if (!pair) {
        throw new Error('Enhanced field did not expose an undamaged two-rock physical cluster');
      }
      const dx = pair.primary.position.x - pair.payload.position.x;
      const dy = pair.primary.position.y - pair.payload.position.y;
      const distance = Math.hypot(dx, dy) || 1;
      const latchDistance = pair.primary.r + ship.r + 72;
      return {
        primary: {
          id: pair.primary.id,
          position: { ...pair.primary.position },
          size: pair.primary.r,
        },
        payload: {
          id: pair.payload.id,
          position: { ...pair.payload.position },
          size: pair.payload.r,
        },
        latchPosition: {
          x: pair.primary.position.x + (dx / distance) * latchDistance,
          y: pair.primary.position.y + (dy / distance) * latchDistance,
        },
      };
    });
    const separation = Math.hypot(
      fixture.payload.position.x - fixture.primary.position.x,
      fixture.payload.position.y - fixture.primary.position.y
    );
    expect(separation).toBeGreaterThan(fixture.primary.size + fixture.payload.size + 4);
    expect(separation).toBeLessThanOrEqual(400);

    await game.placeShipAt(fixture.latchPosition.x, fixture.latchPosition.y);
    const launcher = page.locator('#asteroid-tools-launcher');
    expect(await launcher.isVisible()).toBe(true);
    await launcher.tap();
    expect(await page.locator('#asteroid-tools-overlay').isVisible()).toBe(true);
    await page
      .locator('#asteroid-tools-overlay [data-asteroid-tools-target]')
      .selectOption(fixture.primary.id);
    await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="latch"]').tap();
    await page.waitForFunction(
      (id) => {
        const motion = window.gameController?.getAsteroidToolsController?.()?.getState?.()
          ?.pilot?.asteroidMotion;
        return motion?.mode === 'latched' && motion.asteroidId === id;
      },
      fixture.primary.id,
      { timeout: 15_000, polling: 100 }
    );

    const latched = await page.evaluate((id) => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      const rock = gc
        .getCurrRoidBelt()
        .getRoids()
        .find((candidate) => candidate.id === id);
      if (!rock) {
        throw new Error('Primary asteroid disappeared after latch');
      }
      const offset = { x: ship.position.x - rock.position.x, y: ship.position.y - rock.position.y };
      const relative = {
        x: ship.velocity.x - rock.velocity.x,
        y: ship.velocity.y - rock.velocity.y,
      };
      const radius = Math.hypot(offset.x, offset.y) || 1;
      const tangent = Math.abs((-offset.y * relative.x + offset.x * relative.y) / radius);
      const radial = Math.abs((offset.x * relative.x + offset.y * relative.y) / radius);
      return {
        tangent,
        radial,
        mode: gc.getAsteroidToolsController().getState().pilot?.asteroidMotion?.mode,
        tetherMode: gc.getAsteroidToolsController().getState().pilot?.asteroidMotion?.tetherMode,
        primary: rock.position,
        ship: ship.position,
      };
    }, fixture.primary.id);
    expect(latched.mode).toBe('latched');
    expect(latched.tetherMode).toBe('spin');
    expect(latched.tangent).toBeGreaterThanOrEqual(latched.radial);

    await page
      .locator('#asteroid-tools-overlay [data-asteroid-tools-target]')
      .selectOption(fixture.payload.id);
    await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="anchor"]').tap();
    await page.waitForFunction(
      (id) => {
        const motion = window.gameController?.getAsteroidToolsController?.()?.getState?.()
          ?.pilot?.asteroidMotion;
        return motion?.mode === 'latched' && motion.payloadId === id;
      },
      fixture.payload.id,
      { timeout: 15_000, polling: 100 }
    );
    // AsteroidToolsController debounces touch actions for 250ms to collapse duplicate
    // taps; wait for that real UI gate before issuing the next command.
    await page.waitForTimeout(300);
    await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="brake"]').tap();
    await page.waitForFunction(
      () =>
        window.gameController?.getAsteroidToolsController?.()?.getState?.()?.pilot?.asteroidMotion
          ?.tetherMode === 'brake',
      undefined,
      { timeout: 15_000, polling: 100 }
    );
    await page.waitForTimeout(300);
    await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="spin"]').tap();
    await page.waitForFunction(
      () =>
        window.gameController?.getAsteroidToolsController?.()?.getState?.()?.pilot?.asteroidMotion
          ?.tetherMode === 'spin',
      undefined,
      { timeout: 15_000, polling: 100 }
    );

    const fuelBeforeSpin = await page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      return ship?.fuel ?? -1;
    });
    await page.keyboard.down('KeyW');
    let powered:
      | { tangent: number; speed: number; fuel: number; angularVelocity: number }
      | undefined;
    // The payload adds orbital inertia; measure real acceleration instead of
    // demanding the speed of a much lighter, single-rock sling.
    let powerBaseline: { tangent: number; angularVelocity: number } | undefined;
    const powerDeadline = Date.now() + 3500;
    try {
      while (Date.now() < powerDeadline) {
        const sample = await page.evaluate((id) => {
          const gc = window.gameController;
          if (!gc) {
            throw new Error('Game controller is unavailable');
          }
          const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
          if (!ship) {
            throw new Error('Local ship is unavailable');
          }
          const rock = gc
            .getCurrRoidBelt()
            .getRoids()
            .find((candidate) => candidate.id === id);
          if (!rock) {
            return null;
          }
          const offset = {
            x: ship.position.x - rock.position.x,
            y: ship.position.y - rock.position.y,
          };
          const radius = Math.hypot(offset.x, offset.y) || 1;
          // Aim along the live tangential direction so the real held thrust
          // applies torque to the owned rock instead of only pushing radially.
          ship.angle = Math.atan2(-offset.x, -offset.y);
          const relative = {
            x: ship.velocity.x - rock.velocity.x,
            y: ship.velocity.y - rock.velocity.y,
          };
          return {
            tangent: Math.abs((-offset.y * relative.x + offset.x * relative.y) / radius),
            speed: Math.hypot(ship.velocity.x, ship.velocity.y),
            fuel: ship.fuel,
            angularVelocity: Math.abs(rock.angularVelocity),
          };
        }, fixture.primary.id);
        if (!sample) {
          throw new Error('Primary asteroid disappeared while building tangent motion');
        }
        powerBaseline ??= sample;
        powered = sample;
        if (sample.tangent - powerBaseline.tangent > 0.5) {
          break;
        }
        await page.waitForTimeout(50);
      }
    } finally {
      await page.keyboard.up('KeyW');
      await page.evaluate(() => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (ship) {
          ship.thrusting = false;
        }
      });
    }
    if (!powered || !powerBaseline || powered.tangent - powerBaseline.tangent <= 0.5) {
      throw new Error(`Hauler did not build bounded tangent motion: ${JSON.stringify(powered)}`);
    }
    expect(powered.speed).toBeGreaterThan(0.5);
    expect(powered.speed).toBeLessThanOrEqual(18.1);
    expect(powered.angularVelocity).toBeGreaterThan(powerBaseline.angularVelocity + 0.003);
    expect(powered.fuel).toBeLessThan(fuelBeforeSpin);

    const attached = await page.evaluate(
      ({ primaryId, payloadId }) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('Game controller is unavailable');
        }
        const roids = gc.getCurrRoidBelt().getRoids();
        const primary = roids.find((candidate) => candidate.id === primaryId);
        const payload = roids.find((candidate) => candidate.id === payloadId);
        const state = gc.getAsteroidToolsController().getState().pilot?.asteroidMotion;
        const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
        if (!state || !primary || !payload || !ship) {
          throw new Error('Attached cluster state is unavailable');
        }
        return {
          mode: state.mode,
          payloadId: state.payloadId,
          payloadPosition: { ...payload.position },
          distance:
            primary && payload
              ? Math.hypot(
                  payload.position.x - primary.position.x,
                  payload.position.y - primary.position.y
                )
              : -1,
          velocity: Math.hypot(ship.velocity.x, ship.velocity.y),
        };
      },
      { primaryId: fixture.primary.id, payloadId: fixture.payload.id }
    );
    expect(attached.mode).toBe('latched');
    expect(attached.payloadId).toBe(fixture.payload.id);
    expect(attached.distance).toBeGreaterThan(fixture.primary.size + fixture.payload.size + 4);
    expect(attached.distance).toBeLessThanOrEqual(410);

    await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="release"]').tap();
    await page.waitForFunction(
      () => {
        const motion = window.gameController?.getAsteroidToolsController?.()?.getState?.()
          ?.pilot?.asteroidMotion;
        return motion && motion.mode !== 'latched' && !motion.asteroidId && !motion.payloadId;
      },
      undefined,
      { timeout: 5000, polling: 10 }
    );
    const released = await page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const motion = gc.getAsteroidToolsController().getState().pilot?.asteroidMotion;
      if (!motion) {
        throw new Error('Asteroid motion is unavailable');
      }
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      return {
        mode: motion.mode,
        payloadId: motion.payloadId,
        speed: Math.hypot(ship.velocity.x, ship.velocity.y),
      };
    });
    expect(released.payloadId).toBeUndefined();
    expect(released.speed).toBeGreaterThan(0.1);
    expect(released.speed).toBeLessThanOrEqual(18.1);
    await page.waitForFunction(
      () => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('Game controller is unavailable');
        }
        const motion = gc.getAsteroidToolsController().getState().pilot?.asteroidMotion;
        if (!motion) {
          throw new Error('Asteroid motion is unavailable');
        }
        const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
        if (!ship) {
          throw new Error('Local ship is unavailable');
        }
        return (
          motion.mode === 'free' &&
          !ship.serverOwnsMotion &&
          Math.hypot(ship.velocity.x, ship.velocity.y) <= 6.1
        );
      },
      undefined,
      { timeout: 5000, polling: 100 }
    );
    await page.waitForFunction(
      ({ id, origin }) => {
        const rock = window.gameController
          ?.getCurrRoidBelt?.()
          ?.getRoids?.()
          ?.find((item) => item.id === id);
        return rock && Math.hypot(rock.position.x - origin.x, rock.position.y - origin.y) > 0.5;
      },
      { id: fixture.payload.id, origin: attached.payloadPosition },
      { timeout: 5000, polling: 50 }
    );

    const movingPayload = await page.evaluate((id) => {
      const rock = window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .find((item) => item.id === id);
      if (!rock) {
        throw new Error('Released payload disappeared');
      }
      return {
        position: { ...rock.position },
        speed: Math.hypot(rock.velocity.x, rock.velocity.y),
      };
    }, fixture.payload.id);
    expect(movingPayload.speed).toBeGreaterThan(0.1);
    expect(
      Math.hypot(
        movingPayload.position.x - attached.payloadPosition.x,
        movingPayload.position.y - attached.payloadPosition.y
      )
    ).toBeGreaterThan(0.5);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath('hauler-touch-anchor-release-mobile.png'),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: screenshotManager.getScreenshotPath('hauler-touch-anchor-release-desktop.png'),
    });
    expect(consoleState.errors).toEqual([]);
    expect(consoleState.warnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
