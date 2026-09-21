import { expect, test } from 'vitest';
import {
  CIVIC_LOTS,
  civicLot,
  civicModuleName,
  FURNACES,
  isTownSquareArrival,
  pipeToTownSquare,
  TOWN_HEARTH,
  TOWN_SPAWN_RADIUS,
  townSquareSpawn,
  validCivicModules,
  validLitCivicLotIds,
} from '../../../shared/furnaces';
import { WORLD } from '../../../shared/world';

function boundaryDistance(x: number, y: number): number {
  const size = WORLD.sectorSize;
  const mx = ((x % size) + size) % size;
  const my = ((y % size) + size) % size;
  return Math.min(mx, size - mx, my, size - my);
}

test('Town Square is the only pre-lit hearth and sits on the origin', () => {
  expect(FURNACES).toEqual([TOWN_HEARTH]);
  expect(TOWN_HEARTH.position).toEqual({ x: 0, y: 0 });
  expect(TOWN_HEARTH.radius).toBe(85);
});

test('street lots keep a whole grate inside one sector and clear of each other', () => {
  expect(CIVIC_LOTS.filter((lot) => lot.ring === 1)).toHaveLength(6);
  expect(CIVIC_LOTS.filter((lot) => lot.ring === 2)).toHaveLength(12);
  expect(CIVIC_LOTS.filter((lot) => lot.ring === 3)).toHaveLength(24);
  expect(new Set(CIVIC_LOTS.map((lot) => lot.cost))).toEqual(new Set([1_500, 6_000, 24_000]));
  expect(new Set(CIVIC_LOTS.map((lot) => lot.name)).size).toBe(CIVIC_LOTS.length);
  for (const lot of CIVIC_LOTS) {
    expect(boundaryDistance(lot.position.x, lot.position.y)).toBeGreaterThanOrEqual(lot.radius);
    expect(Math.hypot(lot.position.x, lot.position.y)).toBeGreaterThanOrEqual(400);
    expect(Math.hypot(lot.position.x, lot.position.y)).toBeLessThanOrEqual(WORLD.radius - 500);
    for (const other of CIVIC_LOTS) {
      if (other.id === lot.id) {
        continue;
      }
      expect(
        Math.hypot(lot.position.x - other.position.x, lot.position.y - other.position.y)
      ).toBeGreaterThanOrEqual(400);
    }
  }
});

test('a street stays dark until its nearer lot is a legal parent', () => {
  const first = civicLot('street-1-0');
  const second = civicLot('street-2-0');
  const third = civicLot('street-3-1');
  if (!first || !second || !third) {
    throw new Error('Missing civic street lots');
  }
  expect(first.parentId).toBe(TOWN_HEARTH.id);
  expect(second.parentId).toBe('street-1-0');
  expect(third.parentId).toBe('street-2-0');
  expect(validLitCivicLotIds(['street-1-0'])).toBe(true);
  expect(validLitCivicLotIds(['street-2-0', 'street-1-0'])).toBe(true);
  expect(validLitCivicLotIds(['street-2-0'])).toBe(false);
  expect(validLitCivicLotIds(['street-1-0', 'street-1-0'])).toBe(false);
  expect(validLitCivicLotIds(['built:pilot:1'])).toBe(false);
  expect(validLitCivicLotIds('street-1-0')).toBe(false);
  expect(validCivicModules([{ id: 'street-1-0', builderName: 'Ada' }])).toBe(true);
  expect(
    validCivicModules([{ id: 'street-1-0', builderName: 'Ada', builderId: 'client-ada' }])
  ).toBe(true);
  expect(validCivicModules([{ id: 'street-1-0', builderName: 'Ada', builderId: '' }])).toBe(false);
  expect(validCivicModules([{ id: 'street-1-0', builderName: 'Ada', builderId: 'bad\nid' }])).toBe(
    false
  );
  expect(civicModuleName('Ada', first.name)).toBe(`Ada's ${first.name}`);
  expect(civicModuleName('', first.name)).toBe(first.name);
  expect(validCivicModules([{ id: 'street-2-0', builderName: 'Ada' }])).toBe(false);
  expect(validCivicModules([{ id: 'street-1-0', builderName: 'Ada!' }])).toBe(false);
  expect(validCivicModules([{ id: 'street-1-0', builderName: 'A'.repeat(21) }])).toBe(false);
});

test('a street pipe runs from the source grate through each nearer lot to Town Square', () => {
  const first = civicLot('street-1-0');
  const second = civicLot('street-2-0');
  const third = civicLot('street-3-1');
  const secondParent = civicLot('street-1-0');
  const thirdParent = civicLot('street-2-0');
  if (!first || !second || !third || !secondParent || !thirdParent) {
    throw new Error('Missing civic street lots');
  }
  expect(pipeToTownSquare(TOWN_HEARTH.id)).toEqual([TOWN_HEARTH.position]);
  expect(pipeToTownSquare('missing')).toEqual([]);
  expect(pipeToTownSquare(first.id)).toEqual([first.position, TOWN_HEARTH.position]);
  expect(pipeToTownSquare(second.id)).toEqual([
    second.position,
    secondParent.position,
    TOWN_HEARTH.position,
  ]);
  expect(pipeToTownSquare(third.id)).toEqual([
    third.position,
    thirdParent.position,
    secondParent.position,
    TOWN_HEARTH.position,
  ]);
});

test('fresh flights stand on the town ring', () => {
  for (let index = 0; index < 20; index++) {
    const position = townSquareSpawn(() => index / 20);
    expect(Math.hypot(position.x, position.y)).toBeCloseTo(TOWN_SPAWN_RADIUS, 5);
    expect(isTownSquareArrival(position)).toBe(true);
  }
  expect(isTownSquareArrival({ x: 8_000, y: 0 })).toBe(false);
});
