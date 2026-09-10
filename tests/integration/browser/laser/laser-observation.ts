import type { Page } from 'playwright';
import { ROID } from '../../../../src/constants';
import type { BrowserManager } from '../../utils/browser-manager';
import { GameInteractions } from '../../utils/game-interactions';

interface ObservedLaser {
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  onCanvas: boolean;
}

/** Initially park each pilot, then re-park all of them after every client joins. */
export async function bootLaserClients(browserManager: BrowserManager, count: 2 | 3 = 2) {
  const pages: Page[] = [];
  const games: GameInteractions[] = [];
  for (let index = 0; index < count; index++) {
    const page = index === 0 ? browserManager.getCurrentPage() : await browserManager.createPage();
    if (!page) {
      throw new Error('Browser page is not available');
    }
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await parkLaserClient(game, index);
    pages.push(page);
    games.push(game);
  }
  await Promise.all(games.map((game) => game.waitForCombatReady()));
  await Promise.all(games.map((game) => game.waitForRemoteHumanPlayers(count - 1)));
  await parkLaserClients(games);
  const [page1, page2, page3] = pages;
  const [game1, game2, game3] = games;
  if (!page1 || !page2 || !game1 || !game2) {
    throw new Error('Two laser clients were not created');
  }
  return {
    page1,
    page2,
    page3,
    game1,
    game2,
    game3,
  };
}

/** Keep the actual simulation running in a clear, nearby firing lane. */
export async function parkLaserClient(game: GameInteractions, index = 0): Promise<void> {
  await game.placeShipAt(ROID.FIELD_RADIUS + 500, index * 100);
}

/** Re-establish every participant's clear firing lane after all clients join. */
export async function parkLaserClients(games: readonly GameInteractions[]): Promise<void> {
  await Promise.all(games.map((game, index) => parkLaserClient(game, index)));
  await Promise.all(games.map((game) => game.waitForCombatReady()));
}

export async function localPlayerId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const id = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.id;
    if (!id) {
      throw new Error('Local player has not joined');
    }
    return id;
  });
}

/** Start this promise before firing: short-lived shots can disappear before input returns. */
export async function observeLaser(
  page: Page,
  ownerId: string,
  remote: boolean,
  requireOnCanvas = false
): Promise<ObservedLaser> {
  const handle = await page.waitForFunction(
    ({ ownerId, remote, requireOnCanvas }) => {
      const gc = window.gameController;
      const local = gc?.getPlayerManager()?.getLocalPlayer?.();
      const owner = remote
        ? gc
            ?.getNetworkManager()
            ?.getAllPlayers()
            .find((player) => player.id === ownerId && player.type === 'remote')
        : local?.id === ownerId
          ? local
          : undefined;
      const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
      if (!owner || !local || !canvas) {
        return false;
      }
      const laser = owner.ship.lasers.find((shot) => {
        const values = [shot.position.x, shot.position.y, shot.velocity.x, shot.velocity.y];
        return (
          !shot.hasExploded &&
          values.every(Number.isFinite) &&
          Math.hypot(shot.velocity.x, shot.velocity.y) > 0
        );
      });
      if (!laser) {
        return false;
      }
      // The playfield uses fixed zoom 1 and is centered on the viewer's ship.
      const onCanvas =
        Math.abs(laser.position.x - local.ship.position.x) < canvas.width / 2 &&
        Math.abs(laser.position.y - local.ship.position.y) < canvas.height / 2;
      if (requireOnCanvas && !onCanvas) {
        return false;
      }
      return {
        ownerId: owner.id,
        x: laser.position.x,
        y: laser.position.y,
        vx: laser.velocity.x,
        vy: laser.velocity.y,
        onCanvas,
      };
    },
    { ownerId, remote, requireOnCanvas },
    { timeout: 15000, polling: 'raf' }
  );
  try {
    const laser = await handle.jsonValue();
    if (!laser) {
      throw new Error('Laser observation missing');
    }
    return laser;
  } finally {
    await handle.dispose();
  }
}

export async function waitForLaserCleanup(
  page: Page,
  ownerId: string,
  remote: boolean
): Promise<void> {
  const handle = await page.waitForFunction(
    ({ id, remote }) => {
      const gc = window.gameController;
      const local = gc?.getPlayerManager()?.getLocalPlayer?.();
      const owner = remote
        ? gc
            ?.getNetworkManager()
            ?.getAllPlayers()
            .find((player) => player.id === id && player.type === 'remote')
        : local?.id === id
          ? local
          : undefined;
      return owner !== undefined && owner.ship.lasers.length === 0;
    },
    { id: ownerId, remote },
    { timeout: 20000, polling: 'raf' }
  );
  await handle.dispose();
}
