import { expect, test } from 'vitest';
import { listShipKits } from '../../../shared/shipKits';
import { shipRatings } from '../../../src/wiki/shipScorecard';

test('Hauler rates highest for hull while Scout rates highest for compact size and firing', () => {
  const hauler = shipRatings('hauler');
  const scout = shipRatings('scout');
  expect(hauler.find((stat) => stat.label === 'Hull')?.rating).toBe(5);
  expect(scout.find((stat) => stat.label === 'Hull')?.rating).toBe(1);
  expect(scout.find((stat) => stat.label === 'Speed cap')?.rating).toBe(3);
  expect(hauler.find((stat) => stat.label === 'Speed cap')?.rating).toBe(3);
  for (const label of ['Size', 'Shot interval']) {
    expect(scout.find((stat) => stat.label === label)?.rating).toBe(5);
  }
  expect(shipRatings('scout').find((stat) => stat.label === 'E cooldown')?.rating).toBe(1);
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

test('both kits display equal movement values and ratings', () => {
  for (const label of ['Thrust', 'Speed cap', 'Turn rate']) {
    const scout = shipRatings('scout').find((stat) => stat.label === label);
    const hauler = shipRatings('hauler').find((stat) => stat.label === label);
    expect(hauler).toEqual(scout);
    expect(scout?.rating).toBe(3);
  }
});
