import type { Page } from 'playwright';
import type { GameInteractions } from './game-interactions';

/**
 * Place the pilot beside an actual rendered contour, using the normal server
 * test route. The spot is inside the area the `empty` crew
 * fixture clears, so no asteroid can ram the locked ship (a locked ship is
 * not spawn-protected). Callers arrange the `empty` field first.
 */
export async function placePilotNearContour(page: Page, game: GameInteractions): Promise<void> {
  const capture = await page.evaluateHandle<
    typeof import('../../../src/physics/terrain/contourCapture')
  >("import('/src/physics/terrain/contourCapture.ts')");
  try {
    const point = await capture.evaluate((terrain) => {
      // Spiral out from a point well south of Town Square.
      for (let radius = 0; radius <= 600; radius += 10) {
        for (let turn = 0; turn < 48; turn++) {
          const angle = (turn / 48) * Math.PI * 2;
          const x = Math.round(Math.cos(angle) * radius);
          const y = Math.round(-1_300 + Math.sin(angle) * radius);
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
