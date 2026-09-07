import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';
import { bootLaserClients, localPlayerId, observeLaser } from './laser-observation';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('laser communication works between multiple clients', async () => {
  const { page1, page2, game1, game2 } = await bootLaserClients(browserManager);
  const id1 = await localPlayerId(page1);
  const id2 = await localPlayerId(page2);
  const [forward] = await Promise.all([observeLaser(page2, id1, true), game1.fireLasersWithMouse(1)]);
  const [reverse] = await Promise.all([observeLaser(page1, id2, true), game2.fireLasersWithMouse(1)]);
  expect(forward.ownerId).toBe(id1);
  expect(reverse.ownerId).toBe(id2);
}, TestConfig.DEFAULT_TIMEOUT * 2);
