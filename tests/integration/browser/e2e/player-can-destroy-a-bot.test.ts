import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

// Comprehensive, scenario-based end-to-end coverage of combat against bots.
const { browserManager } = createBrowserScenarioHooks(__dirname);

// Scenario: a player lines up on a bot and shoots it down, scoring the kill.
test('a player destroys a bot with lasers and is awarded the kill', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);

  await game.bootGame();

  // The server spawns bot opponents.
  await game.waitForBots(1);
  const bots = await game.getBots();
  expect(bots.length).toBeGreaterThan(0);
  const hostileBotId = await game.getHostileBotId();
  const target = bots.find((bot) => bot.id === hostileBotId);
  expect(target, 'an alive hostile bot should be available for laser damage').toBeDefined();
  if (!target) return;
  const initialHealth = target.health;

  const scoreBefore = await game.getScore();

  // Hammer the chosen bot with close-range laser fire until it goes down.
  const result = await game.attackBotWithLasers(target.id, 12);

  // The bot visibly took damage from our fire...
  expect(result.minHealthObserved, 'bot should take laser damage').toBeLessThan(initialHealth);

  // ...and was destroyed: a bot kill is worth 50 points, which the server
  // awards to us and syncs back.
  await expect
    .poll(() => game.getScore(), { timeout: 8000, message: 'destroying a bot should award points' })
    .toBeGreaterThanOrEqual(scoreBefore + 50);
}, TestConfig.DEFAULT_TIMEOUT);
