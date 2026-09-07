import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';
import { bootLaserClients, localPlayerId, observeLaser } from './laser-observation';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('remote player lasers are visible on other clients', async () => {
  const { page1, page2, game1 } = await bootLaserClients(browserManager);
  const shooterId = await localPlayerId(page1);
  const [seen] = await Promise.all([
    observeLaser(page2, shooterId, true, true),
    game1.fireLasersWithMouse(1),
  ]);
  expect(seen.ownerId).toBe(shooterId);
  expect(seen.onCanvas).toBe(true);
}, TestConfig.DEFAULT_TIMEOUT * 2);
