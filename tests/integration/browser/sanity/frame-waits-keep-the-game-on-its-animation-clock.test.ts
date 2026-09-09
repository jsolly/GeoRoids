import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('waiting for frames does not advance the game ahead of its animation clock', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Browser page missing');
  }
  const game = new GameInteractions(page);
  await game.bootGame({ waitForCombatReady: false });
  const observation = await page.evaluateHandle(() => {
    const controller = window.gameController;
    if (!controller?.getIsGameRunning()) {
      throw new Error('Game is not running');
    }
    const update = controller.updateGame;
    let updates = 0;
    let frames = 0;
    let frameId = 0;
    controller.updateGame = (...args) => {
      updates++;
      update.apply(controller, args);
    };
    const observeFrame = () => {
      frames++;
      frameId = requestAnimationFrame(observeFrame);
    };
    frameId = requestAnimationFrame(observeFrame);
    return {
      stop: () => {
        controller.updateGame = update;
        cancelAnimationFrame(frameId);
        return { updates, frames };
      },
    };
  });
  try {
    await game.waitForAnimationFrames(20);
    const counts = await observation.evaluate((state) => state.stop());
    expect(counts.frames).toBeGreaterThanOrEqual(20);
    expect(counts.updates).toBeGreaterThan(0);
    // The observer and game callbacks can straddle one frame at setup/teardown.
    expect(counts.updates).toBeLessThanOrEqual(counts.frames + 1);
  } finally {
    try {
      await observation.evaluate((state) => state.stop());
    } finally {
      await observation.dispose();
    }
  }
});
