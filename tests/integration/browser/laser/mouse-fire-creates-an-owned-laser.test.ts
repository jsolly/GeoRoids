import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { localPlayerId, observeLaser, parkLaserClient } from './laser-observation';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'a mouse click fires a laser owned by the local pilot',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await parkLaserClient(game);
    await game.waitForCombatReady();
    expect(await game.getLocalLaserCount()).toBe(0);
    const shooterId = await localPlayerId(page);
    const [shot] = await Promise.all([
      observeLaser(page, shooterId, false),
      game.fireLasersWithMouse(1),
    ]);
    expect(shot.ownerId).toBe(shooterId);
    expect(Math.hypot(shot.vx, shot.vy)).toBeGreaterThan(0);
  },
  TestConfig.DEFAULT_TIMEOUT
);
