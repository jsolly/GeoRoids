import { afterEach, expect, test, vi } from 'vitest';
import { VISUAL } from '../../../src/constants';
import type { ContourLevel } from '../../../src/physics/terrain/contours';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import {
  ensureTerrain,
  getTerrainContours,
  getTerrainField,
} from '../../../src/physics/terrain/terrainSession';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawIsoContours } from '../../../src/rendering/contourRenderer';
import { contourCandidates } from '../../../src/rendering/contourSpatialIndex';
import { TestPath2D, type TestPathCommand } from '../../support/TestPath2D';

type Segment = ContourLevel['segments'][number];
const level = (segments: Segment[]): ContourLevel => ({ index: 0, height: 100, segments });
const view = { x: 0, y: 0, width: 448, height: 448, scale: 1, pad: 32 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The original renderer predicate, including equality at all four padded edges.
function visible(segment: Segment, camera: typeof view) {
  const ax = camera.width / 2 + (segment.ax - camera.x) * camera.scale;
  const ay = camera.height / 2 + (segment.ay - camera.y) * camera.scale;
  const bx = camera.width / 2 + (segment.bx - camera.x) * camera.scale;
  const by = camera.height / 2 + (segment.by - camera.y) * camera.scale;
  return !(
    (ax < -camera.pad && bx < -camera.pad) ||
    (ax > camera.width + camera.pad && bx > camera.width + camera.pad) ||
    (ay < -camera.pad && by < -camera.pad) ||
    (ay > camera.height + camera.pad && by > camera.height + camera.pad)
  );
}

test('padded edges, negative cells and crossing lines retain the full-scan draw order', () => {
  const segments = [
    { ax: 2000, ay: 0, bx: -2000, by: 0 },
    { ax: -256, ay: -256, bx: -256, by: 256 },
    { ax: 256, ay: 256, bx: 256, by: -256 },
    { ax: -256, ay: -256, bx: 256, by: -256 },
    { ax: -256, ay: 256, bx: 256, by: 256 },
    { ax: -2000, ay: -2000, bx: 2000, by: 2000 },
    { ax: -257, ay: -257, bx: -257, by: -257 },
    { ax: 4096, ay: 4096, bx: 4100, by: 4100 },
  ];
  const levels = [level(segments)];
  const candidates = contourCandidates(levels, 0, view);
  expect(candidates.filter((segment) => visible(segment, view))).toEqual(segments.slice(0, 6));
  expect(new Set(candidates).size).toBe(candidates.length);
  expect(candidates).not.toContain(segments[7]);
});

test('moving and zooming cameras emit exactly the same segment sequence as a full scan', () => {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const levels = Array.from({ length: 3 }, (_, index) => ({
    index,
    height: index * 100,
    segments: Array.from({ length: 1500 }, () => {
      const ax = random() * 6400 - 3200;
      const ay = random() * 6400 - 3200;
      return { ax, ay, bx: ax + random() * 100 - 50, by: ay + random() * 100 - 50 };
    }),
  }));
  for (let frame = 0; frame < 100; frame++) {
    const camera = {
      ...view,
      x: random() * 8000 - 4000,
      y: random() * 8000 - 4000,
      width: frame % 2 ? 390 : 844,
      height: frame % 2 ? 844 : 390,
      scale: [0.5, 1, 1.15, 2][frame % 4] ?? 1,
    };
    for (const [index, contour] of levels.entries()) {
      const expected = contour.segments.filter((segment) => visible(segment, camera));
      const actual = contourCandidates(levels, index, camera).filter((segment) =>
        visible(segment, camera)
      );
      expect(actual).toEqual(expected);
    }
  }
});

test('cached viewport queries avoid offscreen endpoint reads and rebuild for replacement terrain', () => {
  let reads = 0;
  const segments: Segment[] = Array.from({ length: 10000 }, (_, index) => {
    const x = (index % 100) * 100 - 5000;
    const y = Math.floor(index / 100) * 100 - 5000;
    return {
      get ax() {
        reads++;
        return x;
      },
      get ay() {
        reads++;
        return y;
      },
      get bx() {
        reads++;
        return x + 20;
      },
      get by() {
        reads++;
        return y + 20;
      },
    };
  });
  const levels = [level(segments)];
  contourCandidates(levels, 0, view);
  reads = 0;
  const candidates = contourCandidates(levels, 0, view);
  expect(reads).toBe(0);
  candidates.filter((segment) => visible(segment, view));
  expect(reads).toBeLessThan(segments.length * 4 * 0.05);
  const replacement = [level([{ ax: 0, ay: 0, bx: 10, by: 10 }])];
  expect(contourCandidates(replacement, 0, view)).toEqual(replacement[0]?.segments);
  expect(contourCandidates(levels, 0, { ...view, x: 1e9, y: 1e9 })).toEqual([]);
  expect(contourCandidates(levels, 0, { ...view, scale: 0 })).toBe(segments);
});

test('camera motion within the same cells reuses candidates without changing retained results', () => {
  const segments = [
    { ax: -200, ay: 0, bx: -180, by: 20 },
    { ax: 275, ay: 0, bx: 285, by: 0 },
    { ax: 4096, ay: 0, bx: 4100, by: 0 },
  ];
  const levels = [level(segments)];
  const firstCamera = { ...view, x: 32, y: 32 };
  const first = contourCandidates(levels, 0, firstCamera);
  const retained = [...first];
  for (let x = 33; x < 64; x++) {
    const camera = { ...firstCamera, x };
    const candidates = contourCandidates(levels, 0, camera);
    expect(candidates).toBe(first);
    expect(candidates.filter((segment) => visible(segment, camera))).toEqual(
      segments.filter((segment) => visible(segment, camera))
    );
  }
  const distantCamera = { ...firstCamera, x: 4096 };
  expect(contourCandidates(levels, 0, distantCamera)).toEqual([segments[2]]);
  expect(first).toEqual(retained);
  expect(contourCandidates(levels, 0, firstCamera)).toEqual(first);
});

test('renderer reuses world paths until the candidate arrays or terrain change', () => {
  vi.stubGlobal('Path2D', TestPath2D);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Missing contour test canvas');
  }
  const viewport = { width: view.width, height: view.height };
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue(viewport);
  vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
  const beginPath = vi.spyOn(ctx, 'beginPath');
  const strokes: Array<{
    path: TestPath2D;
    lineWidth: number;
    transform: ReturnType<CanvasRenderingContext2D['getTransform']>;
  }> = [];
  const nativeStroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    const path = args[0];
    if (path instanceof TestPath2D) {
      strokes.push({ path, lineWidth: ctx.lineWidth, transform: ctx.getTransform() });
      return;
    }
    Reflect.apply(nativeStroke, ctx, args);
  });

  const prior = getTerrainField();
  try {
    ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: 3100 });
    const levels = getTerrainContours();
    const firstCamera = { x: 32, y: 32 };
    const firstCandidates = levels.map((_, index) =>
      contourCandidates(levels, index, { ...view, ...firstCamera })
    );
    const expectedPaths = firstCandidates.filter((candidates) => candidates.length > 0);
    ctx.setTransform(3, 0, 0, 3, 0, 0);

    drawIsoContours(firstCamera, 0);

    expect(strokes).toHaveLength(expectedPaths.length);
    for (const [index, candidates] of expectedPaths.entries()) {
      const expectedCommands: TestPathCommand[] = candidates.flatMap((segment) => [
        { kind: 'moveTo', x: segment.ax, y: segment.ay },
        { kind: 'lineTo', x: segment.bx, y: segment.by },
      ]);
      const stroke = strokes[index];
      expect(stroke?.path.commands).toEqual(expectedCommands);
      expect(stroke?.lineWidth).toBe(VISUAL.CONTOUR_STROKE_WIDTH);
      expect(stroke?.transform.a).toBe(3);
      expect(stroke?.transform.d).toBe(3);
      expect(stroke?.transform.e).toBe(3 * (viewport.width / 2 - firstCamera.x));
      expect(stroke?.transform.f).toBe(3 * (viewport.height / 2 - firstCamera.y));
    }
    expect(ctx.getTransform()).toMatchObject({ a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 });

    const firstPaths = strokes.splice(0).map(({ path }) => path);
    beginPath.mockClear();
    drawIsoContours({ x: 33, y: 32 }, 0);
    expect(strokes.map(({ path }) => path)).toEqual(firstPaths);

    strokes.length = 0;
    beginPath.mockClear();
    drawIsoContours({ x: 1e9, y: 1e9 }, 0);
    expect(strokes).toEqual([]);

    strokes.length = 0;
    ensureTerrain(TERRAIN.DEFAULT_SEED + 1, { cx: 0, cy: 0, radius: 3100 });
    drawIsoContours(firstCamera, 0);
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.every(({ path }) => !firstPaths.includes(path))).toBe(true);
  } finally {
    ensureTerrain(prior.seed, { cx: prior.cx, cy: prior.cy, radius: prior.radius });
  }
});
