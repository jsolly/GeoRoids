import { expect, test, vi } from 'vitest';
import { CIVIC_LOTS } from '../../../shared/furnaces';
import { WORLD } from '../../../shared/world';
import { VISUAL } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { MINIMAP_FURNACE_MARK_SIZE } from '../../../src/rendering/hud/furnaceMapMark';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';
import {
  drawMiniMap,
  RADAR_CLOSE_LANDMARK_GAP,
  seatLandmarkBesideHull,
} from '../../../src/rendering/hud/minimap';

const SOUTHEAST = CIVIC_LOTS.find((lot) => lot.name === 'Southeast Street I');
if (!SOUTHEAST) {
  throw new Error('Southeast Street I is part of the street plan');
}

function radarCenter(layout: ReturnType<typeof computeHudLayout>): { x: number; y: number } {
  return {
    x: layout.miniMap.x + layout.miniMap.size / 2,
    y: layout.miniMap.y + layout.miniMap.size / 2,
  };
}

function foundationMarks(
  calls: ReadonlyArray<ReadonlyArray<unknown>>
): Array<{ x: number; y: number }> {
  return calls
    .filter((call) => call[2] === MINIMAP_FURNACE_MARK_SIZE)
    .map((call) => ({ x: Number(call[0]), y: Number(call[1]) }));
}

function nearestMark(
  marks: readonly { x: number; y: number }[],
  point: { x: number; y: number }
): { x: number; y: number } {
  const mark = marks.reduce((closest, candidate) =>
    Math.hypot(candidate.x - point.x, candidate.y - point.y) <
    Math.hypot(closest.x - point.x, closest.y - point.y)
      ? candidate
      : closest
  );
  return mark;
}

test('a grate above the ship stays above the radar hull, and one below stays below', () => {
  const player = new Player({
    id: 'pilot',
    name: 'John',
    type: 'local',
    input: new MockPlayerInput(),
  });
  // Greater world Y is down the screen. Flight north is the top of the canvas.
  const besideGrate = 220;
  player.ship.position = {
    x: SOUTHEAST.position.x,
    y: SOUTHEAST.position.y + besideGrate,
  };
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Radar scenarios require the real JSDOM canvas context');
  }
  const arc = vi.spyOn(ctx, 'arc');
  const layout = computeHudLayout(canvas, { touchControls: false });
  drawMiniMap(ctx, layout, player.ship, [], [], [], []);
  const center = radarCenter(layout);
  const mark = nearestMark(foundationMarks(arc.mock.calls), center);
  const clear = VISUAL.MINIMAP_LOCAL_SIZE + MINIMAP_FURNACE_MARK_SIZE + RADAR_CLOSE_LANDMARK_GAP;
  expect(mark.y).toBeCloseTo(center.y - clear, 5);
  expect(mark.x).toBeCloseTo(center.x, 5);
  expect(mark.y).toBeLessThan(center.y - VISUAL.MINIMAP_LOCAL_SIZE);

  arc.mockClear();
  player.ship.position = {
    x: SOUTHEAST.position.x,
    y: SOUTHEAST.position.y - besideGrate,
  };
  drawMiniMap(ctx, layout, player.ship, [], [], [], []);
  const below = nearestMark(foundationMarks(arc.mock.calls), center);
  expect(below.y).toBeCloseTo(center.y + clear, 5);
  expect(below.y).toBeGreaterThan(center.y + VISUAL.MINIMAP_LOCAL_SIZE);

  arc.mockClear();
  const insideOffset = 40;
  player.ship.position = {
    x: SOUTHEAST.position.x,
    y: SOUTHEAST.position.y + insideOffset,
  };
  drawMiniMap(ctx, layout, player.ship, [], [], [], []);
  const half = layout.miniMap.size / 2;
  const inside = nearestMark(foundationMarks(arc.mock.calls), center);
  const projectedInsideY = center.y + (-insideOffset / WORLD.minimapRadius) * half;
  expect(inside.x).toBeCloseTo(center.x, 5);
  expect(inside.y).toBeCloseTo(projectedInsideY, 5);
  expect(Math.hypot(inside.x - center.x, inside.y - center.y)).toBeLessThan(clear);
});

test('a street farther than the hull keeps its true radar position', () => {
  const player = new Player({
    id: 'pilot',
    name: 'John',
    type: 'local',
    input: new MockPlayerInput(),
  });
  const eastOfGrate = 900;
  player.ship.position = {
    x: SOUTHEAST.position.x + eastOfGrate,
    y: SOUTHEAST.position.y - 400,
  };
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Radar scenarios require the real JSDOM canvas context');
  }
  const arc = vi.spyOn(ctx, 'arc');
  const layout = computeHudLayout(canvas, { touchControls: false });
  drawMiniMap(ctx, layout, player.ship, [], [], [], []);
  const center = radarCenter(layout);
  const half = layout.miniMap.size / 2;
  const projected = {
    x: center.x + ((SOUTHEAST.position.x - player.ship.position.x) / WORLD.minimapRadius) * half,
    y: center.y + ((SOUTHEAST.position.y - player.ship.position.y) / WORLD.minimapRadius) * half,
  };
  const mark = nearestMark(foundationMarks(arc.mock.calls), projected);
  expect(mark.x).toBeCloseTo(projected.x, 5);
  expect(mark.y).toBeCloseTo(projected.y, 5);
  expect(mark.y).not.toBeCloseTo(center.y, 0);
  expect(
    seatLandmarkBesideHull(
      projected,
      center,
      Math.hypot(eastOfGrate, 400),
      SOUTHEAST.radius,
      VISUAL.MINIMAP_LOCAL_SIZE,
      MINIMAP_FURNACE_MARK_SIZE
    )
  ).toEqual(projected);
});
