import type { Page } from 'playwright';
import type { BrowserManager } from './browser-manager';
import { GameInteractions } from './game-interactions';
import { arrangeCrewField } from './test-server-control';

/** Boot two browser clients against the shared server world. */
export async function bootTwoClientGames(
  browserManager: BrowserManager,
  field: 'natural' | 'controlled' = 'natural'
): Promise<{
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

  const options = field === 'controlled' ? { field, waitForCombatReady: false } : undefined;
  await game1.bootGame(options);
  await game2.bootGame(options);
  if (field === 'controlled') {
    const ids = await Promise.all([game1.getLocalPlayerId(), game2.getLocalPlayerId()]);
    const epochs = await arrangeCrewField(ids, 'empty');
    for (const [index, game] of [game1, game2].entries()) {
      const id = ids[index];
      if (!id) {
        throw new Error('Controlled pilot missing');
      }
      await game.waitForControlledFixture(epochs.get(id));
      await game.placeControlledShipAt(index * 120, -500);
    }
  }
  await game1.waitForRemotePlayers(1);
  await game2.waitForRemotePlayers(1);

  return { page1, page2, game1, game2 };
}
