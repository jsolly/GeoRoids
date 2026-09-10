import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'player can move and thrust ship',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    await game.bootGame();

    const startPos = await game.getShipPosition();
    const startAngle = await game.getShipAngle();

    await game.holdMovementKey('ArrowUp', 800);
    const afterThrust = await game.getShipPosition();
    expect(Math.hypot(afterThrust.x - startPos.x, afterThrust.y - startPos.y)).toBeGreaterThan(5);

    await game.holdMovementKey('ArrowRight', 400);
    const afterTurn = await game.getShipAngle();
    expect(Math.abs(afterTurn - startAngle)).toBeGreaterThan(0.05);
  },
  TestConfig.DEFAULT_TIMEOUT
);
