import type { Page } from 'playwright';
import { expect, test } from 'vitest';

import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import { SHIP } from '../../../../src/constants';
import { TERRAIN } from '../../../../src/physics/terrain/terrainConfig';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';
import { centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

type Viewport = {
  name: 'desktop' | 'mobile';
  width: number;
  height: number;
  hasTouch: boolean;
};

type Position = { x: number; y: number };
type TimedPosition = Position & { at: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function observeAuthoritativePositions(page: Page): {
  getPosition: (playerId: string) => TimedPosition | undefined;
  getAngle: (playerId: string) => number | undefined;
  getSpeed: (playerId: string) => number | undefined;
  isThrusting: (playerId: string) => boolean | undefined;
} {
  const decoder = new SnapshotDecoder();
  const positions = new Map<string, TimedPosition>();
  const angles = new Map<string, number>();
  const speeds = new Map<string, number>();
  const thrusting = new Map<string, boolean>();

  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const raw = String(payload);
      const result = decoder.readMessage(raw, { acceptSnapshots: true });
      if (result.kind === 'message') {
        if (isRecord(result.message) && result.message['type'] === 'joined') {
          decoder.reset();
          positions.clear();
          angles.clear();
          speeds.clear();
          thrusting.clear();
        }
        return;
      }
      if (result.kind === 'snapshot-rejected') {
        throw result.error;
      }
      const snapshot = result.state;
      for (const entity of snapshot.entities) {
        positions.set(entity.id, { ...entity.position, at: snapshot.gameTime });
        angles.set(entity.id, entity.angle);
        speeds.set(entity.id, Math.hypot(entity.velocity.x, entity.velocity.y));
        thrusting.set(entity.id, entity.thrusting);
      }
    });
  });

  return {
    getPosition: (playerId) => positions.get(playerId),
    getAngle: (playerId) => angles.get(playerId),
    getSpeed: (playerId) => speeds.get(playerId),
    isThrusting: (playerId) => thrusting.get(playerId),
  };
}

function angleDistance(left: number, right: number): number {
  return Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
] satisfies Viewport[]) {
  test(`two pilots see contour cruising in either direction and ordinary crossings on ${viewport.name}`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
    await page.setViewportSize(viewport);
    const observerPage = await browserManager.createAdditionalPage();
    const diagnostics = [watchBrowserDiagnostics(page), watchBrowserDiagnostics(observerPage)];
    const authoritative = observeAuthoritativePositions(page);
    const observed = observeAuthoritativePositions(observerPage);
    const game = new GameInteractions(page);
    const observer = new GameInteractions(observerPage);
    await game.navigateToGame();
    await page.locator('#start-screen').waitFor({ state: 'visible' });
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`contour-title-${viewport.name}.png`),
    });
    await game.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    await observer.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    const playerId = await game.getLocalPlayerId();
    const observerId = await observer.getLocalPlayerId();
    expect(playerId).not.toBe(observerId);
    await arrangeCrewField([playerId, observerId], 'empty');
    const gradient = await page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller unavailable');
      }
      return gc.getTerrainProbe({ x: 1700, y: 3600 }).gradient;
    });
    expect(Math.hypot(gradient.x, gradient.y)).toBeGreaterThan(0.0025);
    const crossingAngle = Math.atan2(-gradient.y, gradient.x);
    const measurements: { local: number; server: number; observer: number }[] = [];
    const session = viewport.hasTouch ? await page.context().newCDPSession(page) : null;

    const camera = await page.evaluateHandle<
      typeof import('../../../../src/rendering/canvasSurface').canvasManager
    >("import('/src/rendering/canvasSurface.ts').then(module => module.canvasManager)");
    let touchActive = false;
    try {
      for (const angle of [
        crossingAngle + Math.PI / 2,
        crossingAngle - Math.PI / 2,
        crossingAngle,
      ]) {
        await observer.placeShipAt(1600, 3450);
        await observer.armSpawnProtection();
        await game.placeShipAt(1700, 3600);
        await game.armSpawnProtection();
        const center = await centerOf(page, '#gameCanvas');
        if (session) {
          await dispatchTouch(session, 'touchStart', [{ ...center, id: 1 }]);
          touchActive = true;
        }
        // Pointer bearings are screen-relative. Track the requested world
        // bearing while the travel camera rotates, then release steering.
        await expect
          .poll(
            async () => {
              const state = await camera.evaluate((surface) => {
                const ship = window.gameController?.getCurrPlayer()?.ship;
                if (!ship) {
                  throw new Error('Missing steering pilot');
                }
                return { rotation: surface.getCameraRotation(), angle: ship.angle };
              });
              const error = Math.atan2(
                Math.sin(angle - state.angle),
                Math.cos(angle - state.angle)
              );
              const correction = Math.max(-0.5, Math.min(0.5, error * 0.4));
              const screenAngle = state.angle + correction - state.rotation;
              const point = {
                x: center.x + Math.cos(screenAngle) * 300,
                y: center.y - Math.sin(screenAngle) * 300,
                id: 1,
              };
              if (session) {
                await dispatchTouch(session, 'touchMove', [point]);
              } else {
                await page.mouse.move(point.x, point.y);
              }
              await game.waitForAnimationFrames(1);
              if (session) {
                await dispatchTouch(session, 'touchMove', [{ ...center, id: 1 }]);
              } else {
                await page.mouse.move(center.x, center.y);
              }
              return angleDistance(await game.getShipAngle(), angle);
            },
            { timeout: 5000, interval: 16 }
          )
          .toBeLessThan(0.01);
        if (session) {
          await dispatchTouch(session, 'touchEnd', []);
          touchActive = false;
        } else {
          await page.mouse.move(center.x, center.y);
        }
        await expect
          .poll(
            () => {
              const heading = authoritative.getAngle(playerId);
              return heading === undefined ? Infinity : angleDistance(heading, angle);
            },
            { timeout: 5000 }
          )
          .toBeLessThan(0.01);
        // Restore the shared start only after real steering has reached its heading.
        await game.placeShipAt(1700, 3600);
        await game.armSpawnProtection();
        // Placement resets velocity. Wait beyond the Scout's 24-frame cruise
        // acceleration, then require the actual speed before measuring snapshots.
        await game.waitForAnimationFrames(30);
        const local = await page.evaluate(() => {
          const ship = window.gameController?.getCurrPlayer()?.ship;
          if (!ship) {
            throw new Error('Local ship missing');
          }
          return {
            angle: ship.angle,
            speed: Math.hypot(ship.velocity.x, ship.velocity.y),
            velocity: { ...ship.velocity },
          };
        });
        const expectedSpeed =
          SHIP.MAX_VELOCITY * (angle === crossingAngle ? 1 : 1 + TERRAIN.CONTOUR_SPEED_BONUS);
        expect(local.speed).toBeGreaterThanOrEqual(expectedSpeed * 0.98);
        const lateral =
          local.velocity.x * Math.sin(local.angle) + local.velocity.y * Math.cos(local.angle);
        expect(Math.abs(lateral)).toBeLessThan(0.01);
        for (const connection of [authoritative, observed]) {
          await expect
            .poll(() => connection.getSpeed(playerId) ?? 0)
            .toBeGreaterThanOrEqual(expectedSpeed * 0.98);
        }
        const before = authoritative.getPosition(playerId);
        const beforeObserved = observed.getPosition(playerId);
        if (!before || !beforeObserved) {
          throw new Error('Both pilots must receive the starting snapshot');
        }
        // A live interval measures displacement received independently by both browsers.
        await page.waitForTimeout(300);
        const after = authoritative.getPosition(playerId);
        const afterObserved = observed.getPosition(playerId);
        if (!after || !afterObserved) {
          throw new Error('Both pilots must receive the moving snapshot');
        }
        for (const [start, end] of [
          [before, after],
          [beforeObserved, afterObserved],
        ] as const) {
          expect(end.at).toBeGreaterThan(start.at);
          const forwardDistance =
            (end.x - start.x) * Math.cos(local.angle) - (end.y - start.y) * Math.sin(local.angle);
          expect(forwardDistance).toBeGreaterThan(10);
        }
        // Snapshot gameTime is the broadcast clock, not the accepted pose's
        // sampling clock. Verify replicated velocity and displacement separately.
        const serverSpeed = authoritative.getSpeed(playerId);
        const observerSpeed = observed.getSpeed(playerId);
        if (serverSpeed === undefined || observerSpeed === undefined) {
          throw new Error('Both pilots must receive the cruise velocity');
        }
        measurements.push({ local: local.speed, server: serverSpeed, observer: observerSpeed });
        expect(authoritative.isThrusting(playerId)).toBe(true);
        expect(observed.isThrusting(playerId)).toBe(true);
      }
      const [forward, reverse, crossing] = measurements;
      if (!forward || !reverse || !crossing) {
        throw new Error('All three routes must be measured');
      }
      expect(crossing.local).toBeCloseTo(SHIP.MAX_VELOCITY, 1);
      for (const key of ['local', 'server', 'observer'] satisfies (keyof typeof forward)[]) {
        expect(forward[key]).toBeGreaterThan(crossing[key] * 1.7);
        expect(reverse[key]).toBeGreaterThan(crossing[key] * 1.7);
        expect(
          forward[key] / reverse[key],
          `${key}: ${JSON.stringify(measurements)}`
        ).toBeGreaterThan(0.9);
        expect(forward[key] / reverse[key], `${key}: ${JSON.stringify(measurements)}`).toBeLessThan(
          1.1
        );
      }
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`contour-cruise-${viewport.name}.png`),
      });
      for (const diagnostic of diagnostics) {
        assertNoBrowserDiagnostics(diagnostic);
      }
    } finally {
      await camera.dispose();
      if (session) {
        if (touchActive) {
          await dispatchTouch(session, 'touchEnd', []);
        }
        await session.detach();
      }
    }
  });
}
