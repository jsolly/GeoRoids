import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';
import { bootLaserClients, localPlayerId, observeLaser } from './laser-observation';

const { browserManager } = createBrowserScenarioHooks();

test(
  'one player laser reaches every connected peer with the same trajectory',
  async () => {
    const { page1, page2, page3, game1 } = await bootLaserClients(browserManager, 3);
    if (!page3) {
      throw new Error('Third browser page is not available');
    }
    const shooterId = await localPlayerId(page1);
    const [peer2, peer3] = await Promise.all([
      observeLaser(page2, shooterId, true),
      observeLaser(page3, shooterId, true),
      game1.fireLasersWithMouse(1),
    ]);
    expect(peer2.ownerId).toBe(shooterId);
    expect(peer3.ownerId).toBe(shooterId);
    expect(peer2.vx).toBeCloseTo(peer3.vx, 4);
    expect(peer2.vy).toBeCloseTo(peer3.vy, 4);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
