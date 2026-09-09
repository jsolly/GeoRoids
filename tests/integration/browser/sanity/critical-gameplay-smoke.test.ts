import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import type { PlayerProjectileState } from '../../../../shared-types';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { localPlayerId, observeLaser, parkLaserClient } from '../laser/laser-observation';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function observeAuthoritativeProjectiles(page: Page): {
  getProjectileIds: (ownerId: string) => Set<string>;
  getProjectileSince: (
    ownerId: string,
    previousIds: ReadonlySet<string>
  ) => PlayerProjectileState | undefined;
  getErrors: () => readonly string[];
} {
  const decoder = new SnapshotDecoder();
  const projectiles = new Map<string, PlayerProjectileState>();
  const errors: string[] = [];

  page.on('websocket', (socket) => {
    if (!/\/ws(?:\?|$)/.test(socket.url())) {
      return;
    }
    socket.on('framereceived', ({ payload }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(payload));
      } catch (error) {
        errors.push(
          `received frame was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
      if (!isRecord(parsed)) {
        return;
      }
      if (parsed['type'] === 'joined') {
        decoder.reset();
        projectiles.clear();
        return;
      }
      if (parsed['type'] !== 'snapshot') {
        return;
      }
      try {
        const snapshot = decoder.decode(parsed['data']);
        for (const projectile of snapshot.playerProjectiles ?? []) {
          projectiles.set(projectile.id, projectile);
        }
      } catch (error) {
        errors.push(
          `authoritative snapshot could not be decoded: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  });

  return {
    getProjectileIds: (ownerId) =>
      new Set(
        [...projectiles.values()]
          .filter((projectile) => projectile.ownerId === ownerId)
          .map((projectile) => projectile.id)
      ),
    getProjectileSince: (ownerId, previousIds) =>
      [...projectiles.values()].find(
        (projectile) => projectile.ownerId === ownerId && !previousIds.has(projectile.id)
      ),
    getErrors: () => [...errors],
  };
}

test(
  'a pilot boots the arena, moves with a key, and fires an owned laser',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const game = new GameInteractions(page);
    const authoritative = observeAuthoritativeProjectiles(page);

    await game.bootGame({ waitForCombatReady: false });
    await game.waitForCombatReady();
    await game.verifyGameCanvas();
    await game.verifyGameArea();

    const beforeMove = await game.getShipPosition();
    await page.keyboard.down('ArrowUp');
    try {
      await game.waitForAnimationFrames(30);
    } finally {
      await page.keyboard.up('ArrowUp');
    }
    await game.waitForAnimationFrames(2);
    const afterMove = await game.getShipPosition();
    expect(Math.hypot(afterMove.x - beforeMove.x, afterMove.y - beforeMove.y)).toBeGreaterThan(1);
    expect(await game.getLives()).toBeGreaterThan(0);

    await parkLaserClient(game);
    await game.waitForCombatReady();
    const shooterId = await localPlayerId(page);
    const projectileIdsBeforeShot = authoritative.getProjectileIds(shooterId);
    const [shot] = await Promise.all([
      observeLaser(page, shooterId, false),
      game.fireLasersWithMouse(1, 0),
    ]);
    expect(shot.ownerId).toBe(shooterId);
    expect(Math.hypot(shot.vx, shot.vy)).toBeGreaterThan(0);

    await expect
      .poll(() => authoritative.getProjectileSince(shooterId, projectileIdsBeforeShot), {
        timeout: 5000,
        message: 'server should publish the local shot in playerProjectiles',
      })
      .toBeDefined();
    const authoritativeShot = authoritative.getProjectileSince(shooterId, projectileIdsBeforeShot);
    if (!authoritativeShot) {
      throw new Error('Authoritative local projectile was not observed after firing');
    }
    expect(authoritativeShot.ownerId).toBe(shooterId);
    expect(Math.hypot(authoritativeShot.velocity.x, authoritativeShot.velocity.y)).toBeGreaterThan(
      0
    );
    expect(
      authoritative.getErrors(),
      'the snapshot observer must retain protocol failures'
    ).toEqual([]);

    await page.screenshot({ path: screenshotManager.getScreenshotPath('performance-desktop.png') });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
