import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

const BOUNDARY_RADIUS = 3100;

test('satellites appear, patrol the arena, and stay inside the boundary', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Page not available');
  }

  const game = new GameInteractions(page);
  await game.bootGame();
  await game.waitForSatellites(2);

  const initial = await game.getSatellites();
  expect(initial.length).toBeGreaterThanOrEqual(2);
  const startById = new Map(initial.map((sat) => [sat.id, { x: sat.x, y: sat.y }]));

  await page.waitForTimeout(2500);

  const later = await game.getSatellites();
  const someoneMoved = later.some((sat) => {
    const start = startById.get(sat.id);
    if (!start) {
      return false;
    }
    return Math.hypot(sat.x - start.x, sat.y - start.y) > 15;
  });
  expect(someoneMoved, 'at least one satellite should patrol').toBe(true);

  for (const sat of later) {
    const dist = Math.hypot(sat.x, sat.y);
    expect(dist, `satellite ${sat.id} should stay inside the boundary`).toBeLessThan(BOUNDARY_RADIUS);
  }
}, TestConfig.DEFAULT_TIMEOUT);
