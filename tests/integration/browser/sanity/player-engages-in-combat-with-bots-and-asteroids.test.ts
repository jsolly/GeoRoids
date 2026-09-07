import { test, expect } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('player engages in combat with bots and asteroids', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);
  await game.bootGame({ waitForCombatReady: false });
  await game.placeShipAt(-1800, -1800);
  await game.syncShipPositionToServer();
  await game.waitForCombatReady();
  await game.waitForAsteroids(1);
  await game.waitForBots(1);

  const scoreBefore = await game.getScore();
  const hostileBotId = await game.getHostileBotId();
  const bot = (await game.getBots()).find((candidate) => candidate.id === hostileBotId);
  expect(bot, 'an alive hostile bot should be available for the combat scenario').toBeDefined();
  const botResult = await game.attackBotWithLasers(bot!.id, 12);

  await expect
    .poll(() => game.getScore(), { timeout: 8000, message: 'combat should increase score' })
    .toBeGreaterThanOrEqual(scoreBefore + 50);

  expect(
    botResult.everExploding || botResult.minHealthObserved <= 0,
    'the selected hostile bot should be destroyed by the laser volley'
  ).toBe(true);

  const scoreAfterBot = await game.getScore();
  const asteroid = (await game.getAsteroidPositions()).find(
    (candidate) => !candidate.isCollabTarget
  );
  expect(asteroid, 'an asteroid should remain for the second combat leg').toBeDefined();

  await game.destroyAsteroidWithLaser(asteroid!, 20000);
  await expect
    .poll(
      async () => !(await game.getAsteroidDetails()).some((candidate) => candidate.id === asteroid!.id),
      { timeout: 8000, message: 'the selected asteroid should be destroyed by a laser' }
    )
    .toBe(true);
  await expect
    .poll(() => game.getScore(), { timeout: 8000, message: 'asteroid destruction should award score' })
    .toBeGreaterThan(scoreAfterBot);
}, TestConfig.DEFAULT_TIMEOUT);
