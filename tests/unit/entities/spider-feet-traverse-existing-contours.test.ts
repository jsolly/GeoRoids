import { expect, test } from 'vitest';
import type { ContourLevel } from '../../../src/physics/terrain/contours';
import { spiderFootContacts } from '../../../src/rendering/spiderFootContacts';

const levels: ContourLevel[] = [-80, 0, 80].map((y, index) => ({
  index,
  height: y,
  segments: [{ ax: -500, ay: y, bx: 500, by: y }],
}));

test('every toe stays on an existing isoline while the spider moves and turns', () => {
  let previousX = 0;
  let moved = false;
  for (let frame = 0; frame < 120; frame++) {
    const feet = spiderFootContacts(
      { position: { x: frame, y: 20 }, angle: frame / 100 },
      levels,
      frame / 60
    );
    expect(feet).toHaveLength(8);
    for (const foot of feet) {
      expect([-80, 0, 80]).toContain(foot.y);
      expect(foot.x).toBeGreaterThanOrEqual(-500);
      expect(foot.x).toBeLessThanOrEqual(500);
    }
    const x = feet[0]?.x ?? 0;
    moved ||= frame > 0 && Math.abs(x - previousX) > 0.01;
    previousX = x;
  }
  expect(moved).toBe(true);
});

test('sparse contour geometry still anchors feet and empty terrain invents no contacts', () => {
  const sparse: ContourLevel[] = [
    { index: 0, height: 0, segments: [{ ax: -1000, ay: 500, bx: 1000, by: 500 }] },
  ];
  const spider = { position: { x: 0, y: 0 }, angle: 0 };
  expect(spiderFootContacts(spider, sparse, 0).every((foot) => foot.y === 500)).toBe(true);
  expect(spiderFootContacts(spider, [], 0)).toEqual([]);
});
