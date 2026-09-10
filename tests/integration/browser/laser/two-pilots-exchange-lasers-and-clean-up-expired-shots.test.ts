import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';
import {
  bootLaserClients,
  localPlayerId,
  observeLaser,
  waitForLaserCleanup,
} from './laser-observation';

const { browserManager } = createBrowserScenarioHooks();

test(
  'two pilots exchange matching laser state and remove each expired shot',
  async () => {
    const { page1, page2, game1, game2 } = await bootLaserClients(browserManager);
    const id1 = await localPlayerId(page1);
    const id2 = await localPlayerId(page2);

    const [local1, remote1] = await Promise.all([
      observeLaser(page1, id1, false),
      observeLaser(page2, id1, true),
      game1.fireLasersWithMouse(1),
    ]);
    expect(remote1.ownerId).toBe(id1);
    expect(remote1.vx).toBeCloseTo(local1.vx, 4);
    expect(remote1.vy).toBeCloseTo(local1.vy, 4);
    await Promise.all([
      waitForLaserCleanup(page1, id1, false),
      waitForLaserCleanup(page2, id1, true),
    ]);

    const [local2, remote2] = await Promise.all([
      observeLaser(page2, id2, false),
      observeLaser(page1, id2, true),
      game2.fireLasersWithMouse(1),
    ]);
    expect(remote2.ownerId).toBe(id2);
    expect(remote2.vx).toBeCloseTo(local2.vx, 4);
    expect(remote2.vy).toBeCloseTo(local2.vy, 4);
    await Promise.all([
      waitForLaserCleanup(page2, id2, false),
      waitForLaserCleanup(page1, id2, true),
    ]);

    expect(await game1.getRemoteHumanPlayerIds()).toContain(id2);
    expect(await game2.getRemoteHumanPlayerIds()).toContain(id1);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
