// @vitest-environment node
import { expect, test } from 'vitest';
import { ECONOMY } from '../../../../shared/economy';
import { WORLD } from '../../../../shared/world';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager } = createBrowserScenarioHooks();

test('death keeps the bank and another pilot can recover and bank the dropped cargo', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Page not available');
  }
  const peerPage = await browserManager.createAdditionalPage();
  const game = new GameInteractions(page);
  const peer = new GameInteractions(peerPage);
  await game.bootGame({ waitForCombatReady: false });
  await peer.bootGame({ waitForCombatReady: false });
  const playerId = await game.getLocalPlayerId();
  const peerId = await peer.getLocalPlayerId();
  const ids = [playerId, peerId];
  const epochs = await arrangeCrewField(ids, 'cargo');
  await game.waitForControlledFixture(epochs.get(playerId));
  await peer.waitForControlledFixture(epochs.get(peerId));
  await expect.poll(() => game.getCargo()).toBe(400);
  await expect.poll(() => game.getScore()).toBe(300);
  const deathPosition = await game.dieOnceViaBoundary();
  await expect.poll(() => game.getCargo()).toBe(0);
  const deathDistance = Math.hypot(deathPosition.x, deathPosition.y);
  await peer.placeControlledShipAt(
    (deathPosition.x * (WORLD.radius - 100)) / deathDistance,
    (deathPosition.y * (WORLD.radius - 100)) / deathDistance
  );
  await peer.waitForAnimationFrames(ECONOMY.cargoSpillEjectFrames + 1);
  await expect
    .poll(async () => (await peer.getLoot()).filter((drop) => drop.kind === 'points').length)
    .toBeGreaterThan(0);
  const stashes = (await peer.getLoot()).filter((drop) => drop.kind === 'points');
  expect((await peer.getCargo()) + stashes.reduce((sum, drop) => sum + (drop.points ?? 0), 0)).toBe(
    400
  );
  for (const { id } of stashes) {
    const stash = (await peer.getLoot()).find((drop) => drop.id === id);
    if (!stash) {
      continue;
    }
    const distance = Math.hypot(stash.x, stash.y);
    const safeDistance = Math.min(distance, WORLD.radius - 25);
    await peer.placeControlledShipAt(
      (stash.x * safeDistance) / distance,
      (stash.y * safeDistance) / distance
    );
    await expect
      .poll(async () => (await peer.getLoot()).some((drop) => drop.id === id))
      .toBe(false);
  }
  await expect.poll(() => peer.getCargo()).toBe(400);
  const carried = await peer.getCargo();
  await peer.placeShipAt(0, 0);
  await peer.waitForAnimationFrames(
    Math.ceil(carried / ECONOMY.offloadPoints) * ECONOMY.offloadIntervalFrames
  );
  await expect.poll(() => peer.getCargo()).toBe(0);
  await expect.poll(() => peer.getScore()).toBe(300 + carried);
  await game.waitForShipAlive();
  expect(await game.getScore()).toBe(300);
  expect(await game.getCargo()).toBe(0);
  expect(await game.isGameRunning()).toBe(true);
}, 60000);
