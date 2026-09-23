import { afterEach, expect, test, vi } from 'vitest';
import { CIVIC_LOTS, civicLot, pipeHopToParent } from '../../../shared/furnaces';
import { WORLD } from '../../../shared/world';
import type { Position } from '../../../shared-types';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { resetWorldExploration, worldFurnaces } from '../../../src/network/worldExploration';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';
import { drawMiniMap } from '../../../src/rendering/hud/minimap';

afterEach(() => {
  worldFurnaces.replaceLit([]);
  resetWorldExploration();
  vi.restoreAllMocks();
});

function wideStrokes(ctx: CanvasRenderingContext2D, draw: () => void) {
  let count = 0;
  const spy = vi.spyOn(ctx, 'stroke').mockImplementation(function stroke(
    this: CanvasRenderingContext2D
  ) {
    if (this.lineWidth * Math.hypot(this.getTransform().a, this.getTransform().b) >= 4) {
      count += 1;
    }
  });
  draw();
  spy.mockRestore();
  return count;
}

function wideTrail(ctx: CanvasRenderingContext2D, draw: () => void): Position[][] {
  const trails: Position[][] = [];
  let current: Position[] = [];
  const moveTo = ctx.moveTo.bind(ctx);
  const lineTo = ctx.lineTo.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    current = [{ x, y }];
    moveTo(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    current.push({ x, y });
    lineTo(x, y);
  });
  vi.spyOn(ctx, 'stroke').mockImplementation(function strokeTrail(this: CanvasRenderingContext2D) {
    if (this.lineWidth * Math.hypot(this.getTransform().a, this.getTransform().b) >= 4) {
      trails.push(current.map((point) => ({ ...point })));
    }
    stroke();
  });
  draw();
  vi.mocked(ctx.moveTo).mockRestore();
  vi.mocked(ctx.lineTo).mockRestore();
  vi.mocked(ctx.stroke).mockRestore();
  return trails;
}

test('the radar draws a fire trail only after that furnace is lit', () => {
  const furnace = civicLot('street-1-0');
  if (!furnace) {
    throw new Error('Missing furnace lot');
  }
  const player = new Player({
    id: 'scout',
    name: 'Scout',
    type: 'local',
    input: new MockPlayerInput(),
  });
  player.ship.position = { ...furnace.position };
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Expected a canvas');
  }
  const layout = computeHudLayout(canvas, { touchControls: false });
  const draw = () => drawMiniMap(ctx, layout, player.ship, [], [], [], []);
  expect(wideStrokes(ctx, draw)).toBe(0);
  worldFurnaces.light(furnace.id, 'Ada');
  const trail = wideTrail(ctx, draw);
  expect(trail).toHaveLength(1);
  const drawn = trail[0] ?? [];
  const hop = pipeHopToParent(furnace.id);
  const center = player.ship.position;
  const expected = hop.map((world) => ({
    x:
      layout.miniMap.x +
      layout.miniMap.size / 2 +
      ((world.x - center.x) / WORLD.minimapRadius) * (layout.miniMap.size / 2),
    y:
      layout.miniMap.y +
      layout.miniMap.size / 2 +
      ((world.y - center.y) / WORLD.minimapRadius) * (layout.miniMap.size / 2),
  }));
  expect(drawn).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(drawn[index]?.x).toBeCloseTo(expected[index]?.x ?? 0, 4);
    expect(drawn[index]?.y).toBeCloseTo(expected[index]?.y ?? 0, 4);
  }
});

test('the radar draws a fire trail when only the pipe crosses the disc', () => {
  const radius = WORLD.minimapRadius;
  let crossing: { lotId: string; ship: Position } | undefined;
  for (const lot of CIVIC_LOTS) {
    const hop = pipeHopToParent(lot.id);
    for (let index = 0; index < hop.length - 1; index += 1) {
      const start = hop[index];
      const end = hop[index + 1];
      if (!start || !end) {
        continue;
      }
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length < radius * 1.5) {
        continue;
      }
      // Offset the ship so every hop vertex sits outside the radar while the
      // chord still clips the disc (min-bend routes can be shorter than max-bend).
      for (const offset of [80, 120, 160, 220]) {
        const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
        const ship = {
          x: mid.x + ((start.y - end.y) / length) * offset,
          y: mid.y + ((end.x - start.x) / length) * offset,
        };
        const outside = hop.every(
          (point) => Math.hypot(point.x - ship.x, point.y - ship.y) > radius
        );
        if (!outside) {
          continue;
        }
        // Segment must still enter the radar disc.
        let closest = Number.POSITIVE_INFINITY;
        for (let t = 0; t <= 1; t += 0.05) {
          const x = start.x + (end.x - start.x) * t;
          const y = start.y + (end.y - start.y) * t;
          closest = Math.min(closest, Math.hypot(x - ship.x, y - ship.y));
        }
        if (closest <= radius) {
          crossing = { lotId: lot.id, ship };
          break;
        }
      }
      if (crossing) {
        break;
      }
    }
    if (crossing) {
      break;
    }
  }
  expect(crossing).toBeDefined();
  if (!crossing) {
    return;
  }
  const player = new Player({
    id: 'scout',
    name: 'Scout',
    type: 'local',
    input: new MockPlayerInput(),
  });
  player.ship.position = crossing.ship;
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Expected a canvas');
  }
  const layout = computeHudLayout(canvas, { touchControls: false });
  worldFurnaces.light(crossing.lotId, 'Ada');
  const draw = () => drawMiniMap(ctx, layout, player.ship, [], [], [], []);
  expect(wideStrokes(ctx, draw)).toBe(1);
});

test('the radar hides a lit pipe that misses the disc', () => {
  const furnace = civicLot('street-1-0');
  if (!furnace) {
    throw new Error('Missing furnace lot');
  }
  const player = new Player({
    id: 'scout',
    name: 'Scout',
    type: 'local',
    input: new MockPlayerInput(),
  });
  player.ship.position = { x: 40_000, y: 40_000 };
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Expected a canvas');
  }
  const layout = computeHudLayout(canvas, { touchControls: false });
  worldFurnaces.light(furnace.id, 'Ada');
  const draw = () => drawMiniMap(ctx, layout, player.ship, [], [], [], []);
  expect(wideStrokes(ctx, draw)).toBe(0);
});
