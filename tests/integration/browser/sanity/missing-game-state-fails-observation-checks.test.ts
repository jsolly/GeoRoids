import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

const { browserManager } = createBrowserScenarioHooks();

test('an unavailable game cannot look healthy, empty, or successfully arranged', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Page not available');
  }
  const game = new GameInteractions(page);
  const observations: Array<[string, () => Promise<unknown>]> = [
    ['asteroid count', () => game.getAsteroidCount()],
    ['loot', () => game.getLoot()],
    ['ship mass', () => game.getShipMass()],
    ['ship radius', () => game.getShipRadius()],
    ['maximum health', () => game.getShipMaxHealth()],
    ['health', () => game.getShipHealth()],
    ['position', () => game.getShipPosition()],
    ['asteroid positions', () => game.getAsteroidPositions()],
    ['explosion state', () => game.isShipExploding()],
    ['lives', () => game.getLives()],
    ['local player id', () => game.getLocalPlayerId()],
    ['score', () => game.getScore()],
    ['satellites', () => game.getSatellites()],
    ['bots', () => game.getBots()],
    ['satellite pickups', () => game.getSatellitePickups()],
    ['game running state', () => game.isGameRunning()],
    ['server spawn protection', () => game.isServerSpawnProtected()],
    ['HUD text', () => game.getHudText()],
    ['laser count', () => game.getLaserCount()],
    ['ship angle', () => game.getShipAngle()],
    ['distance from center', () => game.getShipDistanceFromCenter()],
    ['remote player ids', () => game.getRemoteHumanPlayerIds()],
    ['network player position', () => game.getNetworkPlayerPosition('missing-player')],
    ['player health', () => game.getPlayerHealthById('missing-player')],
    ['spawn protection setup', () => game.armSpawnProtection()],
  ];

  for (const [observation, read] of observations) {
    await expect(read(), observation).rejects.toThrow();
  }

  await expect(game.waitForNetworkAsteroids(1, 50)).rejects.toThrow(
    'gameController is not available'
  );
});
