import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';
import { bootLaserClients, localPlayerId, observeLaser } from './laser-observation';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('server receives and processes shoot messages', async () => {
  const { page1, page2, game1 } = await bootLaserClients(browserManager);
  const shooterId = await localPlayerId(page1);
  // A local predicted laser or a pre-validation receive log cannot prove that
  // the server accepted the request. Only the other client's exact owner can.
  const [accepted] = await Promise.all([observeLaser(page2, shooterId, true), game1.fireLasersWithMouse(1)]);
  expect(accepted.ownerId).toBe(shooterId);
  expect(Math.hypot(accepted.vx, accepted.vy)).toBeGreaterThan(0);
}, TestConfig.DEFAULT_TIMEOUT * 2);
