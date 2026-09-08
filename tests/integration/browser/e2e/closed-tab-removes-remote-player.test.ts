import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { bootTwoClientGames } from '../../utils/multi-client-setup';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'closing a player tab removes that remote player from the surviving client',
  async () => {
    const { page2, game1 } = await bootTwoClientGames(browserManager);

    const departingId = (await game1.getRemoteHumanPlayerIds())[0];
    expect(departingId, 'client 1 should see client 2 before close').toBeTruthy();
    if (!departingId) {
      throw new Error('Client 2 did not join client 1 remote-player state');
    }

    await page2.close();

    await expect
      .poll(async () => !(await game1.getRemoteHumanPlayerIds()).includes(departingId), {
        timeout: 10000,
        message: 'closed tab should leave client 1 remote-player state',
      })
      .toBe(true);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
