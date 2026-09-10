import type { Page } from 'playwright';
import type { BrowserManager } from './browser-manager';
import { GameInteractions } from './game-interactions';

/** Boot two browser clients against the shared server world. */
export async function bootTwoClientGames(browserManager: BrowserManager): Promise<{
  page1: Page;
  page2: Page;
  game1: GameInteractions;
  game2: GameInteractions;
}> {
  const page1 = browserManager.getCurrentPage();
  if (!page1) {
    throw new Error('First page not available — beforeEach should create it');
  }

  const page2 = await browserManager.createPage();
  const game1 = new GameInteractions(page1);
  const game2 = new GameInteractions(page2);

  await game1.bootGame();
  await game2.bootGame();
  await game1.waitForRemoteHumanPlayers(1);
  await game2.waitForRemoteHumanPlayers(1);

  return { page1, page2, game1, game2 };
}
