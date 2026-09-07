import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';
import { bootLaserClients, localPlayerId, observeLaser } from './laser-observation';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('complete laser network flow works end-to-end', async () => {
  const { page1, page2, game1 } = await bootLaserClients(browserManager);
  const shooterId = await localPlayerId(page1);
  const [local, remote] = await Promise.all([
    observeLaser(page1, shooterId, false),
    observeLaser(page2, shooterId, true),
    game1.fireLasersWithMouse(1),
  ]);
  expect(remote.ownerId).toBe(local.ownerId);
  expect(remote.vx).toBeCloseTo(local.vx, 4);
  expect(remote.vy).toBeCloseTo(local.vy, 4);
}, TestConfig.DEFAULT_TIMEOUT * 2);
