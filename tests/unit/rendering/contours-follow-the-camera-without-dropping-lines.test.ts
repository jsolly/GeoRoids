import { expect, test } from 'vitest';
import type { ContourLevel } from '../../../src/physics/terrain/contours';
import { contourCandidates } from '../../../src/rendering/contourSpatialIndex';

type Segment = ContourLevel['segments'][number];
const level = (segments: Segment[]): ContourLevel => ({ index: 0, height: 100, segments });
const view = { x: 0, y: 0, width: 448, height: 448, scale: 1, pad: 32 };

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
