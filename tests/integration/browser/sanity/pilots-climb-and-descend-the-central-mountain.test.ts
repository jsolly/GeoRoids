import type { CDPSession, Page } from 'playwright';
import { expect, test } from 'vitest';

import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

const { browserManager } = createBrowserScenarioHooks(__dirname);

type Viewport = {
  name: 'desktop' | 'mobile';
  width: number;
  height: number;
  hasTouch: boolean;
};

type Position = { x: number; y: number };
type TouchPoint = { x: number; y: number; id: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function observeAuthoritativePositions(page: Page): {
  getPosition: (playerId: string) => Position | undefined;
} {
  const decoder = new SnapshotDecoder();
  const positions = new Map<string, Position>();

  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const parsed: unknown = JSON.parse(String(payload));
      if (!isRecord(parsed)) {
        return;
      }
      if (parsed['type'] === 'joined') {
        decoder.reset();
        positions.clear();
        return;
      }
      if (parsed['type'] !== 'snapshot') {
        return;
      }

      const snapshot = decoder.decode(parsed['data']);
      for (const entity of snapshot.entities) {
        positions.set(entity.id, { ...entity.position });
      }
    });
  });

  return {
    getPosition: (playerId) => positions.get(playerId),
  };
}

async function centerOf(page: Page, selector: string): Promise<Position> {
  const box = await page.locator(selector).boundingBox();
  if (!box) {
    throw new Error(`Missing touch target ${selector}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dispatchTouch(
  session: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  touchPoints: TouchPoint[]
): Promise<void> {
  await session.send('Input.dispatchTouchEvent', {
    type,
    touchPoints,
    modifiers: 0,
  });
}

async function readTerrain(page: Page): Promise<{
  peak: { height: number };
  slope: { height: number; gradient: { x: number } };
  foot: { height: number };
}> {
  return page.evaluate(() => {
    const gc = window.gameController;
    if (!gc) {
      throw new Error('Game controller missing');
    }
    return {
      peak: gc.getTerrainProbe({ x: 0, y: 0 }),
      slope: gc.getTerrainProbe({ x: 1550, y: 0 }),
      foot: gc.getTerrainProbe({ x: 3100, y: 0 }),
    };
  });
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
] satisfies Viewport[]) {
  test(`a pilot climbs slower than descending the central mountain on ${viewport.name}`, async () => {
    const localDistances: number[] = [];
    const authoritativeDistances: number[] = [];

    for (const angle of [0, Math.PI]) {
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
            !document.getElementById('touch-controls')?.hidden,
          { timeout: 5000 }
        );
      }

      const terrain = await readTerrain(page);
      expect(terrain.peak.height).toBe(1);
      expect(terrain.slope.height).toBeCloseTo(0.5);
      expect(terrain.foot.height).toBe(0);
      expect(terrain.slope.gradient.x).toBeLessThan(0);

      await game.placeShipAt(1550, 0);
      await game.armSpawnProtection();
      await page.evaluate((heading) => {
        const ship = window.gameController?.getCurrShip();
        if (!ship) {
          throw new Error('Local ship missing');
        }
        ship.angle = heading;
      }, angle);

      const localPlayerId = await game.getLocalPlayerId();
      await expect
        .poll(
          () => {
            const position = authoritative.getPosition(localPlayerId);
            return position ? Math.hypot(position.x - 1550, position.y) : Number.POSITIVE_INFINITY;
          },
          { timeout: 5000, interval: 50 }
        )
        .toBeLessThan(1);
      const beforeAuthoritative = authoritative.getPosition(localPlayerId);
      if (!beforeAuthoritative) {
        throw new Error('Authoritative position missing before movement');
      }

      const beforeLocal = await game.getShipPosition();
      if (viewport.hasTouch) {
        const session = await page.context().newCDPSession(page);
        const stick = await centerOf(page, '#touch-stick');
        const direction = angle === 0 ? 1 : -1;
        const touchPoint = { x: stick.x + direction * 42, y: stick.y, id: 1 };
        await dispatchTouch(session, 'touchStart', [touchPoint]);
        await page.waitForFunction(() => window.gameController?.getCurrShip()?.thrusting === true);
        expect(await page.locator('#touch-stick-knob').getAttribute('style')).toContain(
          'translate'
        );
        await page.waitForTimeout(1200);
        await dispatchTouch(session, 'touchEnd', []);
      } else {
        await page.keyboard.down('w');
        await page.waitForTimeout(1200);
        await page.keyboard.up('w');
      }

      const afterLocal = await game.getShipPosition();
      const afterLocalState = await page.evaluate(() => {
        const ship = window.gameController?.getCurrShip();
        if (!ship) {
          throw new Error('Local ship disappeared');
        }
        return { x: ship.position.x, alive: ship.health > 0 && !ship.exploding };
      });
      expect(afterLocalState.alive).toBe(true);
      const direction = angle === 0 ? 1 : -1;
      const localDistance = direction * (afterLocal.x - beforeLocal.x);
      expect(localDistance).toBeGreaterThan(10);
      localDistances.push(localDistance);

      await expect
        .poll(
          () => {
            const position = authoritative.getPosition(localPlayerId);
            return position ? direction * (position.x - beforeAuthoritative.x) : 0;
          },
          { timeout: 5000, interval: 50 }
        )
        .toBeGreaterThan(10);
      const afterAuthoritative = authoritative.getPosition(localPlayerId);
      if (!afterAuthoritative) {
        throw new Error('Authoritative position missing after movement');
      }
      const authoritativeDistance = direction * (afterAuthoritative.x - beforeAuthoritative.x);
      authoritativeDistances.push(authoritativeDistance);

      await page.screenshot({ path: `/tmp/georoids-mountain-${viewport.name}.png` });
      expect(pageErrors).toEqual([]);
      expect(warnings).toEqual([]);
    }

    const [downhill, uphill] = localDistances;
    if (downhill === undefined || uphill === undefined) {
      throw new Error('Both local directions must be measured');
    }
    expect(downhill).toBeGreaterThan(uphill * 1.4);

    const [authoritativeDownhill, authoritativeUphill] = authoritativeDistances;
    if (authoritativeDownhill === undefined || authoritativeUphill === undefined) {
      throw new Error('Both authoritative directions must be measured');
    }
    expect(authoritativeDownhill).toBeGreaterThan(authoritativeUphill * 1.4);
  });
}
