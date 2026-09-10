import { expect, test } from 'vitest';
import { pointsForRoidSize } from '../../../../src/entities/roid/roidScore';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

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
    await game.waitForCombatReady();
    // Keep ambient satellite encounters out of the score baseline while choosing a target.
    await game.placeShipAt(-1800, -1800);
    await game.waitForAsteroids(1);

    const initialScore = await game.getScore();
    const [asteroids, satellites, bots] = await Promise.all([
      game.getAsteroidPositions(),
      game.getSatellites(),
      game.getBots(),
    ]);
    const hazards = [
      ...satellites.map((satellite) => ({ x: satellite.x, y: satellite.y })),
      ...bots
        .filter((bot) => bot.health > 0 && !bot.exploding)
        .map((bot) => ({ x: bot.x, y: bot.y })),
    ];
    const target = asteroids
      .filter(
        (candidate) =>
          candidate.isCollabTarget !== true && candidate.material === 'ice' && candidate.radius < 40
      )
      .map((candidate) => ({
        ...candidate,
        clearance: hazards.length
          ? Math.min(
              ...hazards.map((position) =>
                Math.hypot(candidate.x - position.x, candidate.y - position.y)
              )
            )
          : Number.MAX_SAFE_INTEGER,
      }))
      .sort((left, right) => right.clearance - left.clearance)[0];
    expect(target, 'expected an ordinary ice asteroid clear of hostile actors').toBeDefined();
    if (!target) {
      return;
    }

    await game.destroyAsteroidWithLaser(target, 25000);

    await expect
      .poll(() => destroyedAsteroidIds.has(target.id), {
        timeout: 8000,
        message: 'server should confirm destruction of the chosen asteroid',
      })
      .toBe(true);
    await expect
      .poll(
        async () => {
          await game.runGameFrames(8);
          return game.getScore();
        },
        { timeout: 12000, message: 'destroying an asteroid should award points' }
      )
      .toBe(initialScore + pointsForRoidSize(target.radius));
  },
  TestConfig.DEFAULT_TIMEOUT
);
