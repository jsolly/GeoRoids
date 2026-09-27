import type { Page } from 'playwright';
import type { GameInteractions } from './game-interactions';

/** Place the pilot beside an actual rendered contour, using the normal server test route. */
export async function placePilotNearContour(page: Page, game: GameInteractions): Promise<void> {
  const capture = await page.evaluateHandle<
    typeof import('../../../src/physics/terrain/contourCapture')
  >("import('/src/physics/terrain/contourCapture.ts')");
  try {
    const point = await capture.evaluate((terrain) => {
      for (let y = 3500; y <= 3700; y += 10) {
        for (let x = 1600; x <= 1800; x += 10) {
          if (terrain.findContourCapture({ x, y }, 0)) {
            return { x, y };
          }
        }
      }
      throw new Error('No nearby contour found for the pilot');
    });
    await game.placeShipAt(point.x, point.y);
    await game.armSpawnProtection();
  } finally {
    await capture.dispose();
  }
}
