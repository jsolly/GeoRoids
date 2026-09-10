import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

const BOUNDARY_RADIUS = 3100;

// Scenario: when a player joins, the world is populated with bot opponents that
// roam the arena — and crucially stay *inside* it (they don't fly off to
// infinity), so the player always has someone to fight.
test(
  'bots populate the arena, move around, and stay within the boundary',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);

    await game.navigateToGame();
    await game.startGame();
    await game.waitForGameInitialization(TestConfig.GAME_INIT_TIMEOUT);
    await game.waitForGameReady();

    // Multiple bots are present.
    await game.waitForBots(2);
    const initial = await game.getBots();
    expect(initial.length).toBeGreaterThanOrEqual(2);

    // Record starting positions, then let the simulation run.
    const startById = new Map(initial.map((b) => [b.id, { x: b.x, y: b.y }]));
    await page.waitForTimeout(2500);

    const later = await game.getBots();

    // At least one bot has moved a meaningful distance (bots are not static).
    const someoneMoved = later.some((b) => {
      const start = startById.get(b.id);
      if (!start) {
        return false;
      }
      return Math.hypot(b.x - start.x, b.y - start.y) > 20;
    });
    expect(someoneMoved, 'at least one bot should roam the arena').toBe(true);

    // Every bot stays inside the circular world boundary — the containment that
    // keeps opponents reachable instead of letting them escape to infinity.
    for (const b of later) {
      const dist = Math.hypot(b.x, b.y);
      expect(dist, `bot ${b.id} should stay inside the boundary`).toBeLessThan(BOUNDARY_RADIUS);
    }
  },
  TestConfig.DEFAULT_TIMEOUT
);
