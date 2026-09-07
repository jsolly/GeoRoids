import { test, expect } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('laser chip damage does not kill player', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);
  await game.bootGame();
  await game.waitForCombatReady();

  const livesBefore = await game.getLives();
  const healthBeforeDamage = await game.getShipHealth();
  await game.applyLaserDamageToLocal(1, 25);
  await game.waitForShipHealth(healthBeforeDamage - 25, 20000);
  expect(await game.getLives()).toBe(livesBefore);
}, TestConfig.DEFAULT_TIMEOUT);
