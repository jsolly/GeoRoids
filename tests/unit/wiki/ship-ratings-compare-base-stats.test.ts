import { expect, test } from 'vitest';
import { listShipKits } from '../../../src/entities/ship/shipKits';
import { shipRatings } from '../../../src/wiki/shipScorecard';

test('Hauler rates highest for hull while Surveyor rates highest for quick, compact handling', () => {
  const hauler = shipRatings('hauler');
  const surveyor = shipRatings('surveyor');
  expect(hauler.find((stat) => stat.label === 'Hull')?.rating).toBe(5);
  expect(surveyor.find((stat) => stat.label === 'Hull')?.rating).toBe(1);
  expect(surveyor.find((stat) => stat.label === 'Speed cap')?.rating).toBe(3);
  expect(hauler.find((stat) => stat.label === 'Speed cap')?.rating).toBe(3);
  for (const label of ['Size', 'Thrust', 'Turn rate', 'Shot interval']) {
    expect(surveyor.find((stat) => stat.label === label)?.rating).toBe(5);
  }
  expect(shipRatings('surveyor').find((stat) => stat.label === 'E cooldown')?.rating).toBe(1);
  expect(hauler.find((stat) => stat.label === 'E cooldown')?.rating).toBe(5);
});

test('all ships use seven whole-bubble ratings within the same fleet scale', () => {
  for (const kit of listShipKits()) {
    const ratings = shipRatings(kit.id);
    expect(ratings).toHaveLength(7);
    for (const stat of ratings) {
      expect(Number.isInteger(stat.rating)).toBe(true);
      expect(stat.rating).toBeGreaterThanOrEqual(1);
      expect(stat.rating).toBeLessThanOrEqual(5);
    }
  }
});
