import { expect, test } from 'vitest';

import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'destroying a roid drops a collectible shard that uses grow/loot collect',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForAsteroids(1);

    const initialScore = await game.getScore();
    const initialMass = await game.getShipMass();
    const roids = await game.getAsteroidPositions();
    const target =
      roids.find((roid) => roid.radius < 40 && !roid.isCollabTarget && roid.material === 'ice') ??
      roids.find((roid) => !roid.isCollabTarget && roid.material === 'ice');
    expect(target).toBeTruthy();
    if (!target) {
      return;
    }

    await game.destroyAsteroidWithLaser(target, 25000);

    let drop: { id: string; x: number; y: number } | undefined;
    await expect
      .poll(
        async () => {
          await game.waitForAnimationFrames(4);
          const loot = await game.getLoot();
          const shard = loot.find((item) => item.kind === 'shard');
          if (shard) {
            drop = { id: shard.id, x: shard.x, y: shard.y };
          }
          return Boolean(shard);
        },
        { timeout: 12000, message: 'destroying a roid should drop a shared shard' }
      )
      .toBe(true);

    if (!drop) {
      throw new Error('expected a shard drop after destroying a roid');
    }
    const collectedDrop = drop;

    await game.placeShipAt(collectedDrop.x, collectedDrop.y);

    await expect
      .poll(
        async () => {
          await game.waitForAnimationFrames(6);
          return game.getScore();
        },
        { timeout: 10000, message: 'flying over the shard should tick score' }
      )
      .toBeGreaterThan(initialScore);

    await expect
      .poll(
        async () => {
          await game.waitForAnimationFrames(4);
          return game.getShipMass();
        },
        { timeout: 8000, message: 'collecting the shard should grow via the #458 mass path' }
      )
      .toBeGreaterThan(initialMass);

    await expect
      .poll(
        async () => {
          const loot = await game.getLoot();
          return loot.some((item) => item.id === collectedDrop.id);
        },
        { timeout: 8000, message: 'collected shard should leave the shared field' }
      )
      .toBe(false);
  },
  TestConfig.DEFAULT_TIMEOUT
);
