import { afterEach, expect, test } from 'vitest';
import { cellWorldBounds, ExplorationMap, explorationCellAt } from '../../../shared/exploration';
import { WORLD } from '../../../shared/world';
import { PALETTE } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { resetWorldExploration, setWorldExploration } from '../../../src/network/worldExploration';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';
import { drawMiniMap } from '../../../src/rendering/hud/minimap';

afterEach(resetWorldExploration);

function radarPixel(
  ctx: CanvasRenderingContext2D,
  layout: ReturnType<typeof computeHudLayout>,
  origin: { x: number; y: number },
  world: { x: number; y: number }
): number[] {
  const pixelX = Math.round(
    layout.miniMap.x +
      layout.miniMap.size / 2 +
      ((world.x - origin.x) * layout.miniMap.size) / (2 * WORLD.minimapRadius)
  );
  const pixelY = Math.round(
    layout.miniMap.y +
      layout.miniMap.size / 2 +
      ((world.y - origin.y) * layout.miniMap.size) / (2 * WORLD.minimapRadius)
  );
  return Array.from(ctx.getImageData(pixelX, pixelY, 1, 1).data);
}

test.each([1280, 390])(
  'radar at width %i paints explored ground and fog as solid areas',
  (width) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = 900;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Expected real canvas');
    }
    const player = new Player({
      id: 'scout',
      name: 'Scout',
      type: 'local',
      input: new MockPlayerInput(),
    });
    const origin = { x: 10_000, y: 10_000 };
    player.ship.position = origin;
    const layout = computeHudLayout(canvas, { touchControls: width < 500 });
    const cell = explorationCellAt({ x: origin.x + 800, y: origin.y + 40 });
    if (cell === null) {
      throw new Error('Expected an exploration cell beside the ship');
    }
    const bounds = cellWorldBounds(cell);
    const interior = { x: bounds.x + bounds.size * 0.5, y: bounds.y + bounds.size * 0.5 };
    const sharedEdge = { x: bounds.x, y: interior.y };
    const exploration = new ExplorationMap();
    exploration.reveal(origin, 1_200);
    setWorldExploration(exploration.snapshot());

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawMiniMap(ctx, layout, player.ship, [], [], [], []);

    const ground = radarPixel(ctx, layout, origin, interior);
    const edge = radarPixel(ctx, layout, origin, sharedEdge);
    expect(edge.slice(0, 3)).toEqual(ground.slice(0, 3));
    expect(ground[1] ?? 0).toBeGreaterThan(25);

    const outside = explorationCellAt({ x: origin.x, y: origin.y + WORLD.minimapRadius * 0.85 });
    if (outside === null) {
      throw new Error('Expected a fog cell inside the radar');
    }
    const fogBounds = cellWorldBounds(outside);
    const fog = radarPixel(ctx, layout, origin, {
      x: fogBounds.x + fogBounds.size * 0.5,
      y: fogBounds.y + fogBounds.size * 0.5,
    });
    expect(fog.slice(0, 3)).toEqual([0, 0, 17]);
    expect(fog.slice(0, 3)).not.toEqual(ground.slice(0, 3));
    expect(PALETTE.BG.toLowerCase()).toBe('#000011');
  }
);
