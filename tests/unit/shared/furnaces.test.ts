import { expect, test } from 'vitest';
import {
  CIVIC_LOTS,
  civicLot,
  civicModuleName,
  FURNACES,
  isTownSquareArrival,
  pipeHopToParent,
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
  expect(CIVIC_LOTS.filter((lot) => lot.ring === 1).every((lot) => lot.cost === 1_500)).toBe(true);
  expect(CIVIC_LOTS.filter((lot) => lot.ring === 2).every((lot) => lot.cost === 6_000)).toBe(true);
  expect(CIVIC_LOTS.filter((lot) => lot.ring === 3).every((lot) => lot.cost === 24_000)).toBe(true);
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

test('street lots scatter off a perfect ring and stay in separate bands', () => {
  const radii = (ring: 1 | 2 | 3): number[] =>
    CIVIC_LOTS.filter((lot) => lot.ring === ring).map((lot) =>
      Math.hypot(lot.position.x, lot.position.y)
    );
  const ringMin = (ring: 1 | 2 | 3): number => Math.min(...radii(ring));
  const ringMax = (ring: 1 | 2 | 3): number => Math.max(...radii(ring));
  expect(ringMax(1) - ringMin(1)).toBeGreaterThan(250);
  expect(ringMax(2) - ringMin(2)).toBeGreaterThan(500);
  expect(ringMax(3) - ringMin(3)).toBeGreaterThan(500);
  expect(ringMax(1)).toBeLessThan(ringMin(2));
  expect(ringMax(2)).toBeLessThan(ringMin(3));
  for (const ring of [1, 2, 3] as const) {
    const angles = CIVIC_LOTS.filter((lot) => lot.ring === ring)
      .map((lot) => Math.atan2(lot.position.y, lot.position.x))
      .sort((left, right) => left - right);
    const steps = angles.map((angle, index) => {
      const next = angles[(index + 1) % angles.length] ?? angle;
      const step = next - angle;
      return step > 0 ? step : step + Math.PI * 2;
    });
    expect(Math.max(...steps) - Math.min(...steps)).toBeGreaterThan(0.02);
  }
});

function axisAligned(points: readonly { x: number; y: number }[]): void {
  expect(points.length).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    expect(start && end && (start.x === end.x || start.y === end.y)).toBe(true);
    expect(start && end && (start.x !== end.x || start.y !== end.y)).toBe(true);
  }
}

function cornerCount(points: readonly { x: number; y: number }[]) {
  let corners = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const next = points[index + 1];
    if (!previous || !point || !next) {
      continue;
    }
    const enteredHorizontally = previous.y === point.y;
    const leftHorizontally = point.y === next.y;
    if (enteredHorizontally !== leftHorizontally) {
      corners += 1;
    }
  }
  return corners;
}

test('a street stays dark until its inward parent lot is lit', () => {
  const first = civicLot('street-1-0');
  const second = civicLot('street-2-0');
  const third = civicLot('street-3-1');
  if (!first || !second || !third) {
    throw new Error('Missing civic street lots');
  }
  expect(first.parentId).toBe(TOWN_HEARTH.id);
  expect(second.parentId).toBe('street-1-0');
  expect(third.parentId).toBe('street-2-0');
  for (const lot of CIVIC_LOTS) {
    const index = Number(lot.id.slice(lot.id.lastIndexOf('-') + 1));
    expect(lot.parentId).toBe(
      lot.ring === 1 ? TOWN_HEARTH.id : `street-${lot.ring - 1}-${Math.floor(index / 2)}`
    );
  }
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

test('scatter keeps index parents even when another inward lot is closer', () => {
  const mismatches: string[] = [];
  for (const lot of CIVIC_LOTS) {
    if (lot.ring === 1) {
      expect(lot.parentId).toBe(TOWN_HEARTH.id);
      continue;
    }
    const candidates =
      lot.ring === 2
        ? CIVIC_LOTS.filter((other) => other.ring === 1)
        : CIVIC_LOTS.filter((other) => other.ring === lot.ring - 1);
    const nearest = candidates.reduce((best, other) => {
      const distance = Math.hypot(
        lot.position.x - other.position.x,
        lot.position.y - other.position.y
      );
      const bestDistance = Math.hypot(
        lot.position.x - best.position.x,
        lot.position.y - best.position.y
      );
      return distance < bestDistance ? other : best;
    });
    if (nearest.id !== lot.parentId) {
      mismatches.push(`${lot.id}->${lot.parentId} nearest=${nearest.id}`);
    }
  }
  // Scatter intentionally keeps road parents by ring index, not geometric nearest.
  expect(mismatches.length).toBeGreaterThan(0);
});

test('a street pipe turns at right angles through each inward parent lot to Town Square', () => {
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
  expect(pipeHopToParent('missing')).toEqual([]);
  for (const lot of CIVIC_LOTS) {
    const hop = pipeHopToParent(lot.id);
    const parent =
      lot.parentId === TOWN_HEARTH.id ? TOWN_HEARTH.position : civicLot(lot.parentId)?.position;
    expect(hop[0]).toEqual(lot.position);
    expect(hop[hop.length - 1]).toEqual(parent);
    axisAligned(hop);
    const spanX = Math.abs((parent?.x ?? 0) - lot.position.x);
    const spanY = Math.abs((parent?.y ?? 0) - lot.position.y);
    if (spanX >= 1 && spanY >= 1) {
      expect(cornerCount(hop)).toBeGreaterThanOrEqual(3);
    }
  }
  const toTown = pipeToTownSquare(third.id);
  expect(toTown[0]).toEqual(third.position);
  expect(toTown[toTown.length - 1]).toEqual(TOWN_HEARTH.position);
  expect(toTown).toContainEqual(thirdParent.position);
  expect(toTown).toContainEqual(secondParent.position);
  expect(toTown).toContainEqual(first.position);
  axisAligned(toTown);
  expect(pipeToTownSquare(second.id)[0]).toEqual(second.position);
  expect(pipeToTownSquare(first.id).at(-1)).toEqual(TOWN_HEARTH.position);
});

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number }
): number {
  const abx = end.x - start.x;
  const aby = end.y - start.y;
  const lengthSquared = abx * abx + aby * aby;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * abx + (point.y - start.y) * aby) / lengthSquared)
        );
  return Math.hypot(point.x - (start.x + abx * t), point.y - (start.y + aby * t));
}

test('a street pipe stays outside every other grate', () => {
  const grates = [TOWN_HEARTH, ...CIVIC_LOTS];
  for (const lot of CIVIC_LOTS) {
    const hop = pipeHopToParent(lot.id);
    const parent = hop[hop.length - 1];
    expect(parent).toBeDefined();
    for (let index = 0; index < hop.length - 1; index += 1) {
      const start = hop[index];
      const end = hop[index + 1];
      if (!start || !end || !parent) {
        continue;
      }
      for (const grate of grates) {
        const atStart =
          index === 0 &&
          Math.hypot(grate.position.x - lot.position.x, grate.position.y - lot.position.y) < 1;
        const atEnd =
          index === hop.length - 2 &&
          Math.hypot(grate.position.x - parent.x, grate.position.y - parent.y) < 1;
        if (atStart || atEnd) {
          continue;
        }
        expect(
          distanceToSegment(grate.position, start, end),
          `${lot.id} passes through ${grate.id}`
        ).toBeGreaterThanOrEqual(grate.radius + 6);
      }
    }
  }
});

test('fresh flights stand on the town ring', () => {
  for (let index = 0; index < 20; index++) {
    const position = townSquareSpawn(() => index / 20);
    expect(Math.hypot(position.x, position.y)).toBeCloseTo(TOWN_SPAWN_RADIUS, 5);
    expect(isTownSquareArrival(position)).toBe(true);
  }
  expect(isTownSquareArrival({ x: 8_000, y: 0 })).toBe(false);
});
