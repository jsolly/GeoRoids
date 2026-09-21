import { expect, test } from 'vitest';
import { FURNACES } from '../../../shared/furnaces';
import { sectorAt, WORLD } from '../../../shared/world';

test('regional Works sit in sector interiors instead of on four-way corners', () => {
  const regional = FURNACES.filter((site) => site.id.startsWith('works-'));
  expect(regional.length).toBeGreaterThan(0);
  for (const site of regional) {
    const sector = sectorAt(site.position);
    expect(site.position.x).toBe((sector.x + 0.5) * WORLD.sectorSize);
    expect(site.position.y).toBe((sector.y + 0.5) * WORLD.sectorSize);
    expect(site.position.x % WORLD.sectorSize).not.toBe(0);
    expect(site.position.y % WORLD.sectorSize).not.toBe(0);
  }
});

test('Works 1:0 sits in the middle of its sector, not on the grid cross', () => {
  const furnace = FURNACES.find((site) => site.id === 'works-1-0');
  if (!furnace) {
    throw new Error('Missing regional Works 1:0');
  }
  expect(furnace.position).toEqual({ x: 5_000, y: 1_000 });
  expect(sectorAt(furnace.position).id).toBe('2,0');
});
