import { expect, test } from 'vitest';
import { listShipKits } from '../../../src/entities/ship/shipKits';
import { shipRatings } from '../../../src/wiki/shipScorecard';

test('Hauler rates highest for hull while Skirmisher rates highest for quick, compact handling', () => {
  const hauler = shipRatings('hauler');
  const skirmisher = shipRatings('skirmisher');
  expect(hauler.find((stat) => stat.label === 'Hull')?.rating).toBe(5);
  expect(skirmisher.find((stat) => stat.label === 'Hull')?.rating).toBe(1);
  for (const label of ['Size', 'Thrust', 'Speed cap', 'Turn rate', 'Shot interval']) {
    expect(skirmisher.find((stat) => stat.label === label)?.rating).toBe(5);
  }
  expect(shipRatings('dart').find((stat) => stat.label === 'E cooldown')?.rating).toBe(5);
  expect(hauler.find((stat) => stat.label === 'E cooldown')?.rating).toBe(1);
});

test('all ships use seven whole-bubble ratings and tied thrust values stay equal', () => {
  for (const kit of listShipKits()) {
    const ratings = shipRatings(kit.id);
    expect(ratings).toHaveLength(7);
    for (const stat of ratings) {
      expect(Number.isInteger(stat.rating)).toBe(true);
      expect(stat.rating).toBeGreaterThanOrEqual(1);
      expect(stat.rating).toBeLessThanOrEqual(5);
    }
  }
  expect(shipRatings('dart').find((stat) => stat.label === 'Thrust')?.rating).toBe(
    shipRatings('warden').find((stat) => stat.label === 'Thrust')?.rating
  );
});
