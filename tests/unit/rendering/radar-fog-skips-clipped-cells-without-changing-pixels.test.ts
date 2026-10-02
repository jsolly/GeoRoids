import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import {
  cellWorldBounds,
  ExplorationMap,
  explorationCellsInView,
  isCellExplored,
} from '../../../shared/exploration';
import { WORLD } from '../../../shared/world';
import { drawExplorationFog } from '../../../src/rendering/hud/minimap';

type Geometry = Parameters<typeof drawExplorationFog>[1];

// Frozen pre-optimization raster algorithm. Each cell paints in source order,
// including its one-pixel overlap and the native circular clip's edge coverage.
function legacyFog(ctx: CanvasRenderingContext2D, geometry: Geometry): void {
  const scale = geometry.size / (geometry.radius * 2);
  for (const cell of explorationCellsInView({
    cx: geometry.center.x,
    cy: geometry.center.y,
    radius: geometry.radius,
  })) {
    ctx.fillStyle = isCellExplored(geometry.exploration, cell) ? 'rgb(23,38,59)' : '#000011';
    const bounds = cellWorldBounds(cell);
    ctx.fillRect(
      geometry.x + geometry.size / 2 + (bounds.x - geometry.center.x) * scale,
      geometry.y + geometry.size / 2 + (bounds.y - geometry.center.y) * scale,
      bounds.size * scale + 1,
      bounds.size * scale + 1
    );
  }
}

function raster(
  painter: typeof drawExplorationFog,
  geometry: Geometry,
  angle: number,
  dpr: number
) {
  const canvas = document.createElement('canvas');
  canvas.width = 120 * dpr;
  canvas.height = 120 * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Expected native radar canvas');
  }
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 120, 120);
  ctx.beginPath();
  ctx.arc(60, 60, 40, 0, 2 * Math.PI);
  ctx.clip();
  ctx.translate(60, 60);
  ctx.rotate(angle);
  ctx.translate(-60, -60);
  const fills = vi.spyOn(ctx, 'fillRect');
  painter(ctx, geometry);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return {
    fills: fills.mock.calls.length,
    hash: createHash('sha256').update(pixels).digest('hex'),
    pixels,
  };
}

test.each([1, 2, 3])(
  'radar fog skips clipped cells at DPR %i without changing rotated ground or world edges',
  (dpr) => {
    for (const center of [
      { x: 10_000.35, y: 10_000.65 },
      { x: WORLD.radius - 81.35, y: WORLD.radius - 90.65 },
    ]) {
      const explored = new ExplorationMap();
      explored.reveal(center, 750);
      explored.reveal({ x: center.x + 900, y: center.y - 450 }, 400);
      const geometry = {
        center,
        radius: WORLD.minimapRadius,
        x: 20,
        y: 20,
        size: 80,
        exploration: explored.snapshot(),
        projection: { x: 0, y: 0 },
      };
      for (const angle of [0, Math.PI / 4, Math.PI / 2]) {
        const before = raster(legacyFog, geometry, angle, dpr);
        const after = raster(drawExplorationFog, geometry, angle, dpr);
        const differences = Array.from(after.pixels.entries())
          .filter(([index, value]) => value !== before.pixels[index])
          .slice(0, 12)
          .map(([index, value]) => ({
            x: Math.floor(index / 4) % (120 * dpr),
            y: Math.floor(index / 4 / (120 * dpr)),
            channel: index % 4,
            before: before.pixels[index],
            after: value,
          }));
        expect(after.hash, JSON.stringify({ center, angle, differences })).toBe(before.hash);
        expect(after.fills).toBeLessThan(before.fills);
      }
    }
  }
);
