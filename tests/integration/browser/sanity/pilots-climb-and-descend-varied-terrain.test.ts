import type { Page } from 'playwright';
import { expect, test } from 'vitest';

import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import { WORLD } from '../../../../shared/world';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager } = createBrowserScenarioHooks(__dirname);

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
  isThrusting: (playerId: string) => boolean | undefined;
} {
  const decoder = new SnapshotDecoder();
  const positions = new Map<string, TimedPosition>();
  const angles = new Map<string, number>();
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
        thrusting.set(entity.id, entity.thrusting);
      }
    });
  });

  return {
    getPosition: (playerId) => positions.get(playerId),
    getAngle: (playerId) => angles.get(playerId),
    isThrusting: (playerId) => thrusting.get(playerId),
  };
}

function angleDistance(left: number, right: number): number {
  return Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
}

function sampleLocalPosition(page: Page, startAtRest = false): Promise<TimedPosition> {
  return page.evaluate((shouldStartAtRest) => {
    const ship = window.gameController?.getCurrPlayer()?.ship;
    if (!ship) {
      throw new Error('Local pilot missing during terrain measurement');
    }
    if (shouldStartAtRest) {
      ship.velocity = { x: 0, y: 0 };
    }
    return { ...ship.position, at: performance.now() };
  }, startAtRest);
}

function readTerrain(page: Page): Promise<{
  peak: { height: number };
  slope: { height: number; gradient: { x: number } };
  rim: { height: number };
}> {
  return page.evaluate((rimX) => {
    const gc = window.gameController;
    if (!gc) {
      throw new Error('Game controller missing');
    }
    return {
      peak: gc.getTerrainProbe({ x: 0, y: 0 }),
      slope: gc.getTerrainProbe({ x: 3090, y: 1150 }),
      rim: gc.getTerrainProbe({ x: rimX + 1, y: 0 }),
    };
  }, WORLD.radius);
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
] satisfies Viewport[]) {
  test(`a pilot climbs slower than descending the varied terrain on ${viewport.name}`, async () => {
    const localSpeeds: number[] = [];
    const authoritativeSpeeds: number[] = [];

    for (const angle of [Math.PI, 0]) {
      const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
      await page.setViewportSize(viewport);

      const warnings: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') {
          warnings.push(`${message.type()}: ${message.text()}`);
        }
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));

      const authoritative = observeAuthoritativePositions(page);
      const game = new GameInteractions(page);
      await game.bootGame({ waitForCombatReady: false });

      if (viewport.hasTouch) {
        await page.waitForFunction(
          () =>
            document.body.classList.contains('touch-play') &&
            !document.querySelector<HTMLElement>('#touch-controls')?.hidden,
          { timeout: 5000 }
        );
      }

      const terrain = await readTerrain(page);
      expect(Math.abs(terrain.peak.height)).toBe(0);
      expect(terrain.slope.height).toBeGreaterThan(0);
      expect(terrain.rim.height).toBe(0);
      expect(terrain.slope.gradient.x).toBeGreaterThan(0.002);

      await game.placeShipAt(3090, 1150);
      await game.armSpawnProtection();
      await page.evaluate((heading) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        if (!ship) {
          throw new Error('Local ship missing');
        }
        ship.angle = heading;
      }, angle);

      const localPlayerId = await game.getLocalPlayerId();
      await expect
        .poll(
          () => {
            const authoritativeAngle = authoritative.getAngle(localPlayerId);
            return authoritativeAngle === undefined
              ? Number.POSITIVE_INFINITY
              : angleDistance(authoritativeAngle, angle);
          },
          { timeout: 5000, interval: 50, message: 'server should acknowledge the test heading' }
        )
        .toBeLessThan(0.01);
      await expect
        .poll(
          () => {
            const position = authoritative.getPosition(localPlayerId);
            return position
              ? Math.hypot(position.x - 3090, position.y - 1150)
              : Number.POSITIVE_INFINITY;
          },
          { timeout: 5000, interval: 50 }
        )
        .toBeLessThan(50);
      const beforeAuthoritative = authoritative.getPosition(localPlayerId);
      if (!beforeAuthoritative) {
        throw new Error('Authoritative position missing before movement');
      }

      // Heading acknowledgement takes a variable number of cruising frames.
      // Start both slope runs with the same velocity after that setup completes.
      const beforeLocal = await sampleLocalPosition(page, true);
      if (viewport.hasTouch) {
        const session = await page.context().newCDPSession(page);
        const stick = await centerOf(page, '#gameCanvas');
        const touchPoint = { x: stick.x, y: stick.y - 42, id: 1 };
        try {
          await dispatchTouch(session, 'touchStart', [touchPoint]);
          await page.waitForFunction(
            () => window.gameController?.getCurrPlayer()?.ship?.thrusting === true
          );
          expect(await page.locator('#touch-stick').count()).toBe(0);
          await page.waitForTimeout(1200);
        } finally {
          await dispatchTouch(session, 'touchEnd', []);
          await session.detach();
        }
      } else {
        await page.waitForTimeout(1200);
      }

      const afterLocal = await sampleLocalPosition(page);
      const afterLocalState = await page.evaluate(() => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        if (!ship) {
          throw new Error('Local ship disappeared');
        }
        return { x: ship.position.x, alive: ship.health > 0 && !ship.exploding };
      });
      expect(afterLocalState.alive).toBe(true);
      const direction = angle === 0 ? 1 : -1;
      const localDistance = direction * (afterLocal.x - beforeLocal.x);
      expect(localDistance).toBeGreaterThan(10);
      expect(afterLocal.at).toBeGreaterThan(beforeLocal.at);
      // Touch/CDP and test-process scheduling add variable time around the
      // nominal wait. Compare speed over the observed interval, not raw distance.
      localSpeeds.push(localDistance / (afterLocal.at - beforeLocal.at));

      await expect
        .poll(
          () => {
            const position = authoritative.getPosition(localPlayerId);
            return (
              position !== undefined &&
              direction * (position.x - beforeAuthoritative.x) > 10 &&
              authoritative.isThrusting(localPlayerId) === true
            );
          },
          {
            timeout: 5000,
            interval: 50,
            message: 'measure a server snapshot of automatic cruising across the slope',
          }
        )
        .toBe(true);
      const afterAuthoritative = authoritative.getPosition(localPlayerId);
      if (!afterAuthoritative) {
        throw new Error('Authoritative position missing after movement');
      }
      const authoritativeDistance = direction * (afterAuthoritative.x - beforeAuthoritative.x);
      expect(afterAuthoritative.at).toBeGreaterThan(beforeAuthoritative.at);
      authoritativeSpeeds.push(
        authoritativeDistance / (afterAuthoritative.at - beforeAuthoritative.at)
      );

      await page.screenshot({
        path: `/tmp/georoids-varied-terrain-${viewport.name}-${angle === 0 ? 'uphill' : 'downhill'}.png`,
      });
      expect(pageErrors).toEqual([]);
      expect(warnings).toEqual([]);
    }

    const [downhill, uphill] = localSpeeds;
    if (downhill === undefined || uphill === undefined) {
      throw new Error('Both local directions must be measured');
    }
    // This real route reaches gentler ground; the unit scenario verifies the full steep-slope ratio.
    expect(downhill).toBeGreaterThan(uphill * 1.25);

    const [authoritativeDownhill, authoritativeUphill] = authoritativeSpeeds;
    if (authoritativeDownhill === undefined || authoritativeUphill === undefined) {
      throw new Error('Both authoritative directions must be measured');
    }
    expect(authoritativeDownhill).toBeGreaterThan(authoritativeUphill * 1.25);
  });
}
