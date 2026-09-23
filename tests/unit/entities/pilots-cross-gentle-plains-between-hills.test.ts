import { expect, test } from 'vitest';
import { WORLD } from '../../../shared/world';
import { createHeightfield, sampleHeight } from '../../../src/physics/terrain/heightfield';
import { passageStrength } from '../../../src/physics/terrain/passages';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';

test('roughly half the ground outside narrow cuts has only trivial relief, with both hills and valleys across the world', () => {
  for (const seed of [TERRAIN.DEFAULT_SEED, 42, 1234]) {
    const field = createHeightfield(seed, { radius: WORLD.radius });
    let flat = 0;
    let count = 0;
    let highest = 0;
    let lowest = 0;
    for (let y = -50000; y <= 50000; y += 997) {
      for (let x = -50000; x <= 50000; x += 997) {
        if (Math.hypot(x, y) > 50000 || passageStrength(field, x, y) > 0) {
          continue;
        }
        const h = sampleHeight(field, x, y);
        count++;
        if (Math.abs(h) <= TERRAIN.FLAT_HEIGHT_BAND * TERRAIN.PLAIN_RELIEF_SCALE) {
          flat++;
        }
        highest = Math.max(highest, h);
        lowest = Math.min(lowest, h);
      }
    }
    expect(flat / count).toBeGreaterThan(0.44);
    expect(flat / count).toBeLessThan(0.56);
    expect(highest).toBeGreaterThan(0.2);
    expect(lowest).toBeLessThan(-0.2);
  }
});
