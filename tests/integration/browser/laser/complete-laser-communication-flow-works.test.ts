import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';
import { bootLaserClients, localPlayerId, observeLaser, waitForLaserCleanup } from './laser-observation';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('complete laser communication flow works', async () => {
  const { page1, page2, game1, game2 } = await bootLaserClients(browserManager);
  const shooterId = await localPlayerId(page1);
  const [seen] = await Promise.all([observeLaser(page2, shooterId, true), game1.fireLasersWithMouse(1)]);
  expect(seen.ownerId).toBe(shooterId);
  await waitForLaserCleanup(page2, shooterId);
  // The peer remains connected after removing the expired projectile.
  expect(await game2.getRemoteHumanPlayerIds()).toContain(shooterId);
}, TestConfig.DEFAULT_TIMEOUT * 2);
