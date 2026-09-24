import { expect, test } from 'vitest';
import {
  advanceShipBoost,
  BOOST,
  fullShipBoost,
  startShipBoost,
  stopShipBoost,
} from '../../../shared/shipBoost';
import { Ship } from '../../../src/entities/ship/Ship';

test('a full tank lasts three seconds and can restart during recharge with a new activation', () => {
  const ship = new Ship({ isLocalPlayer: true });
  expect(ship.toggleBoost()).toBe(true);
  for (let frame = 0; frame < 90; frame++) {
    ship.update();
  }
  expect(ship.boost.charge).toBeCloseTo(0.5);
  expect(ship.boosting).toBe(true);
  for (let frame = 0; frame < 90; frame++) {
    ship.update();
  }
  expect(ship.boost).toEqual({ phase: 'exhausted', charge: 0 });
  expect(ship.toggleBoost()).toBe(false);
  for (let frame = 0; frame < 150; frame++) {
    ship.update();
  }
  expect(ship.boost.charge).toBeCloseTo(0.5);
  expect(ship.toggleBoost()).toBe(true);
  for (let frame = 0; frame < 30; frame++) {
    ship.update();
  }
  expect(ship.boost.charge).toBeCloseTo(1 / 3);
  expect(ship.boosting).toBe(true);
  ship.toggleBoost();
  for (let frame = 0; frame < 300; frame++) {
    ship.update();
  }
  expect(ship.boost).toEqual({ phase: 'idle', charge: 1 });
  expect(ship.boosting).toBe(false);
  expect(ship.toggleBoost()).toBe(true);
});

test('switching off early saves charge and permits another partial burst', () => {
  const boost = fullShipBoost();
  startShipBoost(boost);
  advanceShipBoost(boost, 1000);
  stopShipBoost(boost);
  expect(boost.charge).toBeCloseTo(2 / 3);
  advanceShipBoost(boost, 500);
  expect(boost.charge).toBeCloseTo(2 / 3 + 0.1);
  expect(startShipBoost(boost)).toBe(true);
  advanceShipBoost(boost, boost.charge * BOOST.durationMs);
  expect(boost).toEqual({ phase: 'exhausted', charge: 0 });
});

test('elapsed time crossing exhaustion refills only after the tank runs empty', () => {
  const boost = fullShipBoost();
  startShipBoost(boost);
  advanceShipBoost(boost, BOOST.durationMs + BOOST.rechargeMs / 2);
  expect(boost).toEqual({ phase: 'exhausted', charge: 0.5 });
});

test('opening a flight menu stops boost and refills without allowing activation', () => {
  const ship = new Ship({ isLocalPlayer: true });
  ship.toggleBoost();
  ship.update();
  const charge = ship.boost.charge;
  ship.movementLocked = true;
  ship.update();
  expect(ship.boosting).toBe(false);
  expect(ship.boost.charge).toBeGreaterThan(charge);
  expect(ship.toggleBoost()).toBe(false);
});
