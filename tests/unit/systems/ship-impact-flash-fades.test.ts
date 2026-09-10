import { expect, test } from 'vitest';
import { applyShipImpactFlash, tickShipImpactFlash } from '../../../src/entities/ship/shipUtils';

test('impact flash ticks down on the shared player/bot path', () => {
  const ship = { impactFlashFrames: 0 };
  applyShipImpactFlash(ship);
  expect(ship.impactFlashFrames).toBeGreaterThan(0);
  const start = ship.impactFlashFrames;
  tickShipImpactFlash(ship);
  expect(ship.impactFlashFrames).toBe(start - 1);
});
