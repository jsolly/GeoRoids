// @vitest-environment node
import { expect, test } from 'vitest';
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
  await arrangeCrewField(ids, 'impact');
  await expect.poll(() => game.getCargo()).toBe(0);
  await expect
    .poll(async () => (await peer.getLoot()).filter((drop) => drop.kind === 'points').length)
    .toBeGreaterThan(0);
  const stash = (await peer.getLoot()).find((drop) => drop.kind === 'points');
  if (!stash) {
    throw new Error('Death cargo missing');
  }
  await peer.placeShipAt(stash.x, stash.y);
  await expect.poll(() => peer.getCargo()).toBeGreaterThanOrEqual(400);
  const carried = await peer.getCargo();
  await peer.placeShipAt(0, 0);
  await expect.poll(() => peer.getCargo()).toBe(0);
  await expect.poll(() => peer.getScore()).toBe(300 + carried);
  await game.waitForShipAlive();
  expect(await game.getScore()).toBe(300);
  expect(await game.getCargo()).toBe(0);
  expect(await game.isGameRunning()).toBe(true);
}, 60000);
