import { expect, test } from 'vitest';
import { pointsForRoidSize } from '../../../../src/entities/roid/roidScore';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager } = createBrowserScenarioHooks();

type ReceivedMessage = {
  type?: string;
  data?: { asteroidId?: string };
};

test(
  'laser hits and destroys asteroids',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    const destroyedAsteroidIds = new Set<string>();
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const message = JSON.parse(String(payload)) as ReceivedMessage;
        if (message.type === 'asteroidDestroy' && message.data?.asteroidId) {
          destroyedAsteroidIds.add(message.data.asteroidId);
        }
      })
    );
    await game.bootGame();
    await arrangeCrewField([await game.getLocalPlayerId()], 'mining');
    await game.waitForCombatReady();
    await game.placeShipAt(0, -500);
    await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Mining fixture pilot missing');
      }
      ship.angle = Math.PI / 2;
    });
    await expect
      .poll(async () => (await game.getAsteroidPositions()).map((rock) => rock.id))
      .toEqual(['crew-fixture-ore']);
    const [target] = await game.getAsteroidPositions();
    if (!target) {
      throw new Error('Mining fixture asteroid missing');
    }
    const initialScore = await game.getScore();
    await page.keyboard.press('Space');

    await expect
      .poll(() => destroyedAsteroidIds.has(target.id), {
        timeout: 8000,
        message: 'server should confirm destruction of the chosen asteroid',
      })
      .toBe(true);
    await expect
      .poll(
        async () => {
          await game.waitForAnimationFrames(8);
          return game.getScore();
        },
        { timeout: 12000, message: 'destroying an asteroid should award points' }
      )
      .toBe(initialScore + pointsForRoidSize(target.radius));
  },
  TestConfig.DEFAULT_TIMEOUT
);
