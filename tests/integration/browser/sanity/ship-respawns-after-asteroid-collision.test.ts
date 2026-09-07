import { test, expect } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

// Scenario: a player who is destroyed by repeated asteroid collisions loses a
// life and then respawns — back to full health, inside the boundary.
test('ship respawns after asteroid collision when spawn protection ends', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);
  // Join first so the local ship can be moved before waiting on the asteroid
  // field; that keeps the initial spawn outside ambient combat while its
  // server protection is still settling.
  await game.navigateToGame();
  await game.startGame();
  await game.waitForGameReady();
  await game.waitForServerJoin();
  // The initial spawn can receive a live snapshot while the boot barrier is
  // still settling. Move outside the belt, acknowledge that pose, and only
  // then assert the authoritative full-health starting state.
  await game.placeShipAt(-1800, -1800);
  await game.syncShipPositionToServer();
  await game.waitForNetworkAsteroids(1);
  await game.waitForCombatReady();
  const [initialHealth, initialMaxHealth] = await Promise.all([
    game.getShipHealth(),
    game.getShipMaxHealth(),
  ]);
  expect(initialHealth).toBe(initialMaxHealth);
  const initialLives = await game.getLives();

  await game.waitForAsteroids(1);
  const asteroid = (await game.getAsteroidPositions())[0]!;
  expect(asteroid).toBeTruthy();

  await game.crashShipIntoAsteroidUntilDestroyed(asteroid);

  await expect
    .poll(() => game.getLives(), { timeout: 8000, message: 'destruction should cost a life' })
    .toBeLessThan(initialLives);

  await expect
    .poll(
      async () => {
        const [health, maxHealth] = await Promise.all([
          game.getShipHealth(),
          game.getShipMaxHealth(),
        ]);
        return health === maxHealth;
      },
      { timeout: 12000, message: 'ship should respawn at full health' }
    )
    .toBe(true);
  expect(await game.isShipExploding()).toBe(false);
  await expect
    .poll(() => game.getShipDistanceFromCenter(), {
      timeout: 12000,
      message: 'ship should respawn inside the boundary',
    })
    .toBeLessThan(3100);
}, TestConfig.DEFAULT_TIMEOUT);
