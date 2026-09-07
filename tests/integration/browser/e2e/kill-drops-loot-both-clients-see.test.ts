import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test('two clients see the same kill-loot drops', async () => {
  const page1 = browserManager.getCurrentPage();
  if (!page1) throw new Error('Page 1 not available');
  const page2 = await browserManager.createAdditionalPage();
  const game1 = new GameInteractions(page1);
  const game2 = new GameInteractions(page2);

  // Park the collector as soon as it joins. Waiting for combat readiness on
  // both clients first leaves client 1 at the default spawn long enough for
  // ambient combat to kill it before this fixture starts.
  await game1.bootGame({ waitForCombatReady: false });
  await game1.placeShipAt(-1800, -1800);
  await game1.syncShipPositionToServer();
  await game2.bootGame({ waitForCombatReady: false });

  const startMass = await game1.getShipMass();
  const startRadius = await game1.getShipRadius();
  const startMaxHealth = await game1.getShipMaxHealth();

  // Keep the collector outside the active asteroid belt and away from the
  // ambient combatants while the other client is being destroyed. The victim
  // is also placed outside the belt so the only death in this fixture is the
  // hostile server-authoritative laser sequence.
  await game2.placeShipAt(1800, 1800);
  await game2.syncShipPositionToServer();
  await game1.waitForRemoteHumanPlayers(1);
  await game2.waitForRemoteHumanPlayers(1);
  await game1.waitForCombatReady();
  await game2.waitForCombatReady();
  await game2.killLocalPlayerUntilLifeLost();

  await expect
    .poll(
      async () => {
        const loot1 = await game1.getLoot();
        const loot2 = await game2.getLoot();
        if (loot1.length === 0 || loot2.length === 0) {
          return false;
        }
        const ids1 = [...loot1.map((drop) => drop.id)].sort();
        const ids2 = [...loot2.map((drop) => drop.id)].sort();
        return ids1.join(',') === ids2.join(',');
      },
      { timeout: 12000, message: 'both clients should share the same kill-loot ids' }
    )
    .toBe(true);

  const loot1 = await game1.getLoot();
  const loot2 = await game2.getLoot();
  for (const drop of loot1) {
    const peer = loot2.find((other) => other.id === drop.id);
    expect(peer).toBeDefined();
    expect(Math.abs(peer!.x - drop.x)).toBeLessThan(8);
    expect(Math.abs(peer!.y - drop.y)).toBeLessThan(8);
  }

  await page1.screenshot({
    path: screenshotManager.getScreenshotPath('kill-loot-client1-shared-drops.png'),
  });
  await page2.screenshot({
    path: screenshotManager.getScreenshotPath('kill-loot-client2-shared-drops.png'),
  });

  const pellet = loot1[0];
  expect(pellet).toBeDefined();
  await game1.placeShipAt(pellet!.x, pellet!.y);
  await game1.syncShipPositionToServer();

  await expect
    .poll(async () => game1.getShipMass(), {
      timeout: 8000,
      message: 'collector should grow after picking up kill loot',
    })
    .toBeGreaterThan(startMass);

  expect(await game1.getShipRadius()).toBeGreaterThan(startRadius);
  expect(await game1.getShipMaxHealth()).toBeGreaterThan(startMaxHealth);

  await page1.screenshot({
    path: screenshotManager.getScreenshotPath('kill-loot-client1-after-collect.png'),
  });
}, TestConfig.DEFAULT_TIMEOUT * 2);
