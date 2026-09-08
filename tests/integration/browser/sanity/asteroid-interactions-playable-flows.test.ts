import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { captureConsole, waitForEnhancedTargets, driveToAsteroid } from '../../utils/asteroid-tools-driver';
const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test('Hauler touch controls latch, anchor a second rock, brake, spin, and release with bounded tangent motion', async () => {
  await browserManager.recreatePage({ hasTouch: true });
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');
  await page.setViewportSize({ width: 390, height: 844 });
  const consoleState = captureConsole(page);
  const game = new GameInteractions(page);
  await game.bootGame({ waitForCombatReady: false, kitId: 'hauler' });
  await waitForEnhancedTargets(page);

  const fixture = await page.evaluate(() => {
    const gc = (window as any).gameController;
    const state = gc?.getAsteroidToolsController?.()?.getState?.();
    const ship = gc?.playerManager?.getLocalPlayer?.()?.ship;
    const targets = (state?.targets ?? []).filter(
      (target: any) => target.phenomenon?.kind === 'reflective' && target.phenomenon.clusterId
    );
    const groups = new Map<string, any[]>();
    for (const target of targets) {
      const group = groups.get(target.phenomenon.clusterId) ?? [];
      group.push(target);
      groups.set(target.phenomenon.clusterId, group);
    }
    const group = [...groups.values()].find((items) => items.length >= 2);
    if (!ship || !group) throw new Error('Enhanced field did not expose a two-rock physical cluster');
    const primary = group[0];
    const payload = group.find((target: any) => target.id !== primary.id);
    if (!primary || !payload) throw new Error('Physical cluster lacked a payload candidate');
    return {
      primary: { id: primary.id, position: { ...primary.position }, size: primary.size },
      payload: { id: payload.id, position: { ...payload.position }, size: payload.size },
      ship: { x: ship.position.x, y: ship.position.y },
    };
  });
  const separation = Math.hypot(
    fixture.payload.position.x - fixture.primary.position.x,
    fixture.payload.position.y - fixture.primary.position.y
  );
  expect(separation).toBeGreaterThan(fixture.primary.size + fixture.payload.size + 4);
  expect(separation).toBeLessThanOrEqual(400);

  await driveToAsteroid(page, fixture.primary.id, 72);
  const launcher = page.locator('#asteroid-tools-launcher');
  expect(await launcher.isVisible()).toBe(true);
  await launcher.tap();
  expect(await page.locator('#asteroid-tools-overlay').isVisible()).toBe(true);
  await page.locator('#asteroid-tools-overlay [data-asteroid-tools-target]').selectOption(fixture.primary.id);
  await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="latch"]').tap();
  await page.waitForFunction(
    (id) => {
      const motion = (window as any).gameController?.getAsteroidToolsController?.()?.getState?.()?.pilot?.asteroidMotion;
      return motion?.mode === 'latched' && motion.asteroidId === id;
    },
    fixture.primary.id,
    { timeout: 15_000, polling: 100 }
  );

  const latched = await page.evaluate((id) => {
    const gc = (window as any).gameController;
    const ship = gc.playerManager.getLocalPlayer().ship;
    const rock = gc.getCurrRoidBelt().getRoids().find((candidate: any) => candidate.id === id);
    if (!rock) throw new Error('Primary asteroid disappeared after latch');
    const offset = { x: ship.position.x - rock.position.x, y: ship.position.y - rock.position.y };
    const relative = { x: ship.velocity.x - rock.velocity.x, y: ship.velocity.y - rock.velocity.y };
    const radius = Math.hypot(offset.x, offset.y) || 1;
    const tangent = Math.abs((-offset.y * relative.x + offset.x * relative.y) / radius);
    const radial = Math.abs((offset.x * relative.x + offset.y * relative.y) / radius);
    return {
      tangent,
      radial,
      mode: gc.getAsteroidToolsController().getState().pilot.asteroidMotion.mode,
      tetherMode: gc.getAsteroidToolsController().getState().pilot.asteroidMotion.tetherMode,
      primary: rock.position,
      ship: ship.position,
    };
  }, fixture.primary.id);
  expect(latched.mode).toBe('latched');
  expect(latched.tetherMode).toBe('spin');
  expect(latched.tangent).toBeGreaterThanOrEqual(latched.radial);

  await page.locator('#asteroid-tools-overlay [data-asteroid-tools-target]').selectOption(fixture.payload.id);
  await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="anchor"]').tap();
  await page.waitForFunction(
    (id) => {
      const motion = (window as any).gameController?.getAsteroidToolsController?.()?.getState?.()?.pilot?.asteroidMotion;
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
      (window as any).gameController?.getAsteroidToolsController?.()?.getState?.()?.pilot?.asteroidMotion
        ?.tetherMode === 'brake',
    undefined,
      { timeout: 15_000, polling: 100 }
  );
  await page.waitForTimeout(300);
  await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="spin"]').tap();
  await page.waitForFunction(
    () =>
      (window as any).gameController?.getAsteroidToolsController?.()?.getState?.()?.pilot?.asteroidMotion
        ?.tetherMode === 'spin',
    undefined,
      { timeout: 15_000, polling: 100 }
  );

  const fuelBeforeSpin = await page.evaluate(() => {
    const ship = (window as any).gameController?.playerManager?.getLocalPlayer?.()?.ship;
    return ship?.fuel ?? -1;
  });
  await page.keyboard.down('KeyW');
  let powered: { tangent: number; speed: number; fuel: number; angularVelocity: number } | undefined;
  // The payload adds orbital inertia; measure real acceleration instead of
  // demanding the speed of a much lighter, single-rock sling.
  let powerBaseline: { tangent: number; angularVelocity: number } | undefined;
  const powerDeadline = Date.now() + 3500;
  try {
    while (Date.now() < powerDeadline) {
      const sample = await page.evaluate((id) => {
        const gc = (window as any).gameController;
        const ship = gc.playerManager.getLocalPlayer().ship;
        const rock = gc.getCurrRoidBelt().getRoids().find((candidate: any) => candidate.id === id);
        if (!rock) return null;
        const offset = { x: ship.position.x - rock.position.x, y: ship.position.y - rock.position.y };
        const radius = Math.hypot(offset.x, offset.y) || 1;
        // Aim along the live tangential direction so the real held thrust
        // applies torque to the owned rock instead of only pushing radially.
        ship.angle = Math.atan2(-offset.x, -offset.y);
        ship.thrusting = true;
        const relative = { x: ship.velocity.x - rock.velocity.x, y: ship.velocity.y - rock.velocity.y };
        return {
          tangent: Math.abs((-offset.y * relative.x + offset.x * relative.y) / radius),
          speed: Math.hypot(ship.velocity.x, ship.velocity.y),
          fuel: ship.fuel,
          angularVelocity: Math.abs(rock.angularVelocity),
        };
      }, fixture.primary.id);
      if (!sample) throw new Error('Primary asteroid disappeared while building tangent motion');
      powerBaseline ??= sample;
      powered = sample;
      if (sample.tangent - powerBaseline.tangent > 0.5) break;
      await page.waitForTimeout(50);
    }
  } finally {
    await page.keyboard.up('KeyW');
    await page.evaluate(() => {
      const ship = (window as any).gameController?.playerManager?.getLocalPlayer?.()?.ship;
      if (ship) ship.thrusting = false;
    });
  }
  if (!powered || !powerBaseline || powered.tangent - powerBaseline.tangent <= 0.5) {
    throw new Error(`Hauler did not build bounded tangent motion: ${JSON.stringify(powered)}`);
  }
  expect(powered.speed).toBeGreaterThan(0.5);
  expect(powered.speed).toBeLessThanOrEqual(18.1);
  expect(powered.angularVelocity).toBeGreaterThan(powerBaseline.angularVelocity + 0.003);
  expect(powered.fuel).toBeLessThan(fuelBeforeSpin);

  const attached = await page.evaluate(({ primaryId, payloadId }) => {
    const gc = (window as any).gameController;
    const roids = gc.getCurrRoidBelt().getRoids();
    const primary = roids.find((candidate: any) => candidate.id === primaryId);
    const payload = roids.find((candidate: any) => candidate.id === payloadId);
    const state = gc.getAsteroidToolsController().getState().pilot.asteroidMotion;
    return {
      mode: state.mode,
      payloadId: state.payloadId,
      payloadPosition: { ...payload.position },
      distance: primary && payload ? Math.hypot(payload.position.x - primary.position.x, payload.position.y - primary.position.y) : -1,
      velocity: Math.hypot(gc.playerManager.getLocalPlayer().ship.velocity.x, gc.playerManager.getLocalPlayer().ship.velocity.y),
    };
  }, { primaryId: fixture.primary.id, payloadId: fixture.payload.id });
  expect(attached.mode).toBe('latched');
  expect(attached.payloadId).toBe(fixture.payload.id);
  expect(attached.distance).toBeGreaterThan(fixture.primary.size + fixture.payload.size + 4);
  expect(attached.distance).toBeLessThanOrEqual(410);

  await page.locator('#asteroid-tools-overlay [data-asteroid-tools-motion="release"]').tap();
  await page.waitForFunction(
    () => {
      const motion = (window as any).gameController?.getAsteroidToolsController?.()?.getState?.()?.pilot?.asteroidMotion;
      return motion && motion.mode !== 'latched' && !motion.asteroidId && !motion.payloadId;
    },
    undefined,
    { timeout: 5000, polling: 10 }
  );
  const released = await page.evaluate(() => {
    const gc = (window as any).gameController;
    const motion = gc.getAsteroidToolsController().getState().pilot.asteroidMotion;
    const ship = gc.playerManager.getLocalPlayer().ship;
    return { mode: motion.mode, payloadId: motion.payloadId, speed: Math.hypot(ship.velocity.x, ship.velocity.y) };
  });
  expect(released.payloadId).toBeUndefined();
  expect(released.speed).toBeGreaterThan(0.1);
  expect(released.speed).toBeLessThanOrEqual(18.1);
  await page.waitForFunction(
    () => {
      const gc = (window as any).gameController;
      const motion = gc.getAsteroidToolsController().getState().pilot.asteroidMotion;
      const ship = gc.playerManager.getLocalPlayer().ship;
      return motion.mode === 'free' && !ship.serverOwnsMotion && Math.hypot(ship.velocity.x, ship.velocity.y) <= 6.1;
    },
    undefined,
    { timeout: 5000, polling: 100 }
  );

  const movingPayload = await page.evaluate((id) => {
    const rock = (window as any).gameController.getCurrRoidBelt().getRoids().find((item: any) => item.id === id);
    if (!rock) throw new Error('Released payload disappeared');
    return { position: { ...rock.position }, speed: Math.hypot(rock.velocity.x, rock.velocity.y) };
  }, fixture.payload.id);
  expect(movingPayload.speed).toBeGreaterThan(0.1);
  expect(Math.hypot(movingPayload.position.x - attached.payloadPosition.x,
    movingPayload.position.y - attached.payloadPosition.y)).toBeGreaterThan(0.5);

  await page.locator('#asteroid-tools-overlay [data-asteroid-tools-action="close"]').tap();
  expect(await page.locator('#asteroid-tools-overlay').isVisible()).toBe(false);
  expect(await launcher.isVisible()).toBe(true);
  await launcher.tap();
  expect(await page.locator('#asteroid-tools-overlay').isVisible()).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.locator('#asteroid-tools-overlay').isVisible()).toBe(false);
  await page.screenshot({ path: screenshotManager.getScreenshotPath('hauler-touch-anchor-release-mobile.png') });
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const bounds = await launcher.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(80); // Lives/faction/kit/fuel occupy the top HUD.
    await launcher.tap();
    const panel = page.locator('#asteroid-tools-overlay');
    const panelBounds = await panel.boundingBox();
    expect(panelBounds).not.toBeNull();
    expect(panelBounds!.y).toBeGreaterThanOrEqual(80);
    expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: screenshotManager.getScreenshotPath(`asteroid-tools-${viewport.width}.png`) });
    await page.locator('[data-asteroid-tools-action="close"]').tap();
    await page.screenshot({ path: screenshotManager.getScreenshotPath(`asteroid-launcher-${viewport.width}.png`) });
  }
  expect(consoleState.errors).toEqual([]);
  expect(consoleState.warnings).toEqual([]);
}, TestConfig.DEFAULT_TIMEOUT * 2);
