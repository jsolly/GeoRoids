import type { Page } from 'playwright';
import { ROID } from '../../../../src/constants';
import { GameInteractions } from '../../utils/game-interactions';
import type { BrowserManager } from '../../utils/browser-manager';

export interface ObservedLaser {
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  onCanvas: boolean;
}

/** Park each pilot before waiting through the next pilot's join countdown. */
export async function bootLaserClients(browserManager: BrowserManager, count: 2 | 3 = 2) {
  const pages: Page[] = [];
  const games: GameInteractions[] = [];
  for (let index = 0; index < count; index++) {
    const page = index === 0
      ? browserManager.getCurrentPage()
      : await browserManager.createAdditionalPage();
    if (!page) throw new Error('Browser page is not available');
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await parkLaserClient(game, index);
    pages.push(page);
    games.push(game);
  }
  await Promise.all(games.map(game => game.waitForCombatReady()));
  await Promise.all(games.map(game => game.waitForRemoteHumanPlayers(count - 1)));
  return {
    page1: pages[0]!, page2: pages[1]!, page3: pages[2],
    game1: games[0]!, game2: games[1]!, game3: games[2],
  };
}

/** Keep the actual simulation running in a clear, nearby firing lane. */
export async function parkLaserClient(game: GameInteractions, index = 0): Promise<void> {
  await game.placeShipAt(ROID.FIELD_RADIUS + 500, index * 100);
  await game.syncShipPositionToServer();
}

export async function localPlayerId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const id = (window as any).gameController?.playerManager?.getLocalPlayer()?.id;
    if (!id) throw new Error('Local player has not joined');
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
      const gc = (window as any).gameController;
      const local = gc?.playerManager?.getLocalPlayer();
      const owner = remote
        ? gc?.getNetworkManager()?.getAllPlayers().find((player: any) => player.id === ownerId && player.type === 'remote')
        : local?.id === ownerId ? local : undefined;
      const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
      if (!owner || !local || !canvas) return false;
      const laser = owner.ship.lasers.find((shot: any) => {
        const values = [shot.position.x, shot.position.y, shot.velocity.x, shot.velocity.y];
        return !shot.hasExploded && values.every(Number.isFinite) && Math.hypot(shot.velocity.x, shot.velocity.y) > 0;
      });
      if (!laser) return false;
      // The playfield uses fixed zoom 1 and is centered on the viewer's ship.
      const onCanvas = Math.abs(laser.position.x - local.ship.position.x) < canvas.width / 2 &&
        Math.abs(laser.position.y - local.ship.position.y) < canvas.height / 2;
      if (requireOnCanvas && !onCanvas) return false;
      return { ownerId: owner.id, x: laser.position.x, y: laser.position.y,
        vx: laser.velocity.x, vy: laser.velocity.y, onCanvas };
    },
    { ownerId, remote, requireOnCanvas },
    { timeout: 15000, polling: 'raf' }
  );
  try { return await handle.jsonValue() as ObservedLaser; }
  finally { await handle.dispose(); }
}

export async function waitForLaserCleanup(page: Page, ownerId: string): Promise<void> {
  const handle = await page.waitForFunction((id) => {
    const gc = (window as any).gameController;
    const owner = gc?.getNetworkManager()?.getAllPlayers().find((player: any) => player.id === id && player.type === 'remote');
    return owner !== undefined && owner.ship.lasers.length === 0;
  }, ownerId, { timeout: 20000, polling: 'raf' });
  await handle.dispose();
}
