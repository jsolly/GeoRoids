import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { bootTwoClientGames } from '../../utils/multi-client-setup';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'remote player ship is visible to other clients',
  async () => {
    const { game1, game2 } = await bootTwoClientGames(browserManager);

    const remoteIdsOnClient1 = await game1.getRemoteHumanPlayerIds();
    expect(
      remoteIdsOnClient1.length,
      'client 1 should see client 2 as a remote human'
    ).toBeGreaterThan(0);
    const targetId = remoteIdsOnClient1[0]!;

    const startPosOnClient1 = await game1.getNetworkPlayerPosition(targetId);
    expect(
      startPosOnClient1,
      'client 1 should have an initial position for the remote ship'
    ).not.toBeNull();

    await game2.moveShip('up', 1200);
    await game2.runGameFrames(30);

    await expect
      .poll(
        async () => {
          await game1.runGameFrames(10);
          const remotePos = await game1.getNetworkPlayerPosition(targetId);
          const remoteHealth = await game1.getPlayerHealthById(targetId);
          if (!remotePos || !startPosOnClient1) {
            return false;
          }
          const moved = Math.hypot(
            remotePos.x - startPosOnClient1.x,
            remotePos.y - startPosOnClient1.y
          );
          return moved > 5 && remoteHealth > 0;
        },
        { timeout: 20000, message: 'client 1 should see client 2 move via network state' }
      )
      .toBe(true);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
