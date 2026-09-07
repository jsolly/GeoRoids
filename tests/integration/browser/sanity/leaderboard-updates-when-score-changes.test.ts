import { test, expect } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('leaderboard updates when score changes', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  const game = new GameInteractions(page);
  await game.bootGame();
  await game.waitForBots(1);

  const target = (await game.getBots())[0]!;
  const combat = await game.attackBotWithLasers(target.id, 12);
  expect(combat.everExploding || combat.minHealthObserved <= 0).toBe(true);

  await expect
    .poll(() => game.getScore(), { timeout: 8000 })
    .toBeGreaterThanOrEqual(50);

  const board = await game.getLeaderboardEntries();
  const localId = await game.getLocalPlayerId();
  const me = board.find((e) => e.id === localId);
  expect(me?.score ?? 0).toBeGreaterThanOrEqual(50);
}, TestConfig.DEFAULT_TIMEOUT);
