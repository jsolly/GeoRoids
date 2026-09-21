import type { AsteroidData, CivicModule, Position } from '../shared-types';
import { WORLD } from './world';

/** Respawn and fresh-join ring around the Town Square grate. */
export const TOWN_SPAWN_RADIUS = 180;

export const TOWN_HEARTH = {
  id: 'town-square',
  name: 'Town Square',
  position: { x: 0, y: 0 },
  radius: 85,
} as const;

/** Always-lit hearths. Street lots start dark and join this set when built. */
export const FURNACES = [TOWN_HEARTH] satisfies {
  id: string;
  name: string;
  position: Position;
  radius: number;
}[];

interface CivicLot {
  id: string;
  name: string;
  position: Position;
  radius: number;
  ring: 1 | 2 | 3;
  cost: number;
  parentId: string;
}

const STREET_NAMES = ['East', 'Northeast', 'North', 'West', 'South', 'Southeast'] as const;
const ROMAN = ['', 'I', 'II', 'III'] as const;
const RINGS = [
  { ring: 1 as const, count: 6, radius: 1_600, cost: 1_500, offsetDeg: 15 },
  { ring: 2 as const, count: 12, radius: 4_200, cost: 6_000, offsetDeg: 15 },
  { ring: 3 as const, count: 24, radius: 8_600, cost: 24_000, offsetDeg: 7.5 },
];

function boundaryDistance(x: number, y: number): number {
  const size = WORLD.sectorSize;
  const mx = ((x % size) + size) % size;
  const my = ((y % size) + size) % size;
  return Math.min(mx, size - mx, my, size - my);
}

function placeOnRing(radius: number, angle: number, placed: readonly Position[]): Position {
  const step = (0.25 * Math.PI) / 180;
  for (let attempt = 0; attempt < 96; attempt++) {
    const sign = attempt === 0 ? 0 : attempt % 2 === 1 ? 1 : -1;
    const magnitude = Math.ceil(attempt / 2);
    const theta = angle + sign * magnitude * step;
    const position = { x: radius * Math.cos(theta), y: radius * Math.sin(theta) };
    if (boundaryDistance(position.x, position.y) < TOWN_HEARTH.radius) {
      continue;
    }
    if (Math.hypot(position.x, position.y) > WORLD.radius - 500) {
      continue;
    }
    if (Math.hypot(position.x, position.y) < 400) {
      continue;
    }
    if (placed.some((site) => Math.hypot(site.x - position.x, site.y - position.y) < 400)) {
      continue;
    }
    return position;
  }
  throw new Error(`No street lot at radius ${radius}`);
}

function streetIndex(ring: number, index: number): number {
  if (ring === 1) {
    return index;
  }
  if (ring === 2) {
    return Math.floor(index / 2);
  }
  return Math.floor(index / 4);
}

function layoutCivicLots(): CivicLot[] {
  const drafts: Array<Omit<CivicLot, 'name'> & { street: number }> = [];
  const placed: Position[] = [];
  for (const spec of RINGS) {
    const step = (2 * Math.PI) / spec.count;
    const offset = (spec.offsetDeg * Math.PI) / 180;
    for (let index = 0; index < spec.count; index++) {
      const position = placeOnRing(spec.radius, offset + index * step, placed);
      placed.push(position);
      const street = streetIndex(spec.ring, index);
      const parentId =
        spec.ring === 1
          ? TOWN_HEARTH.id
          : `street-${spec.ring - 1}-${spec.ring === 2 ? street : Math.floor(index / 2)}`;
      drafts.push({
        id: `street-${spec.ring}-${index}`,
        position,
        radius: TOWN_HEARTH.radius,
        ring: spec.ring,
        cost: spec.cost,
        parentId,
        street,
      });
    }
  }
  const counts = new Map<string, number>();
  return drafts.map((draft) => {
    const key = `${draft.street}:${draft.ring}`;
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    const street = STREET_NAMES[draft.street] ?? 'Street';
    const base = `${street} Street ${ROMAN[draft.ring]}`;
    const siblings = drafts.filter(
      (other) => other.street === draft.street && other.ring === draft.ring
    ).length;
    const name = siblings > 1 ? `${base} ${String.fromCharCode(65 + seen)}` : base;
    return {
      id: draft.id,
      name,
      position: draft.position,
      radius: draft.radius,
      ring: draft.ring,
      cost: draft.cost,
      parentId: draft.parentId,
    };
  });
}

export const CIVIC_LOTS: readonly CivicLot[] = layoutCivicLots();

/** How fast a delivery light runs along the street pipes, in world units per second. */
export const FURNACE_PIPE_SPEED = 2_400;

const LOT_BY_ID = new Map(CIVIC_LOTS.map((lot) => [lot.id, lot]));

function hearthPosition(id: string): Position | undefined {
  if (id === TOWN_HEARTH.id) {
    return TOWN_HEARTH.position;
  }
  return LOT_BY_ID.get(id)?.position;
}

/**
 * Grate centers from the furnace that took the delivery back to Town Square.
 * The first point is the source. Town Square itself is a single point.
 */
export function pipeToTownSquare(furnaceId: string): readonly Position[] {
  if (furnaceId === TOWN_HEARTH.id) {
    return [TOWN_HEARTH.position];
  }
  const path: Position[] = [];
  const seen = new Set<string>();
  let id = furnaceId;
  while (id !== TOWN_HEARTH.id) {
    if (seen.has(id)) {
      return [];
    }
    seen.add(id);
    const lot = LOT_BY_ID.get(id);
    if (!lot) {
      return [];
    }
    path.push(lot.position);
    id = lot.parentId;
  }
  const square = hearthPosition(TOWN_HEARTH.id);
  if (!square) {
    return [];
  }
  path.push(square);
  return path;
}

export function civicLot(id: string): CivicLot | undefined {
  return LOT_BY_ID.get(id);
}

/** The dark or lit foundation whose grate contains this point, if any. */
export function civicLotAt(position: Position): CivicLot | undefined {
  let found: CivicLot | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const lot of CIVIC_LOTS) {
    const distance = Math.hypot(position.x - lot.position.x, position.y - lot.position.y);
    if (distance <= lot.radius && distance < best) {
      found = lot;
      best = distance;
    }
  }
  return found;
}

/** Display name of a street furnace paid for by one Surveyor. */
export function civicModuleName(builderName: string, streetName: string): string {
  const builder = builderName.trim().replace(/\s+/gu, ' ');
  if (!builder) {
    return streetName;
  }
  return `${builder}'s ${streetName}`;
}

const MODULE_BUILDER_NAME = /^[A-Za-z0-9 ]{0,20}$/u;

function litParentReady(ids: ReadonlySet<string>): boolean {
  for (const id of ids) {
    const lot = LOT_BY_ID.get(id);
    if (!lot) {
      return false;
    }
    if (lot.parentId !== TOWN_HEARTH.id && !ids.has(lot.parentId)) {
      return false;
    }
  }
  return true;
}

/** Lit ids must be real lots, unique, and only children of an already-lit parent. */
export function validLitCivicLotIds(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || ids.has(id)) {
      return false;
    }
    const lot = LOT_BY_ID.get(id);
    if (!lot) {
      return false;
    }
    ids.add(id);
  }
  return litParentReady(ids);
}

/** Saved modules keep a nickname and the same parent order as lit lot ids. */
export function validCivicModules(value: unknown): value is CivicModule[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') {
      return false;
    }
    const built = row as { id?: unknown; builderName?: unknown };
    if (typeof built.id !== 'string' || ids.has(built.id) || !LOT_BY_ID.has(built.id)) {
      return false;
    }
    if (typeof built.builderName !== 'string' || !MODULE_BUILDER_NAME.test(built.builderName)) {
      return false;
    }
    ids.add(built.id);
  }
  return litParentReady(ids);
}

export function townSquareSpawn(random: () => number): Position {
  const angle = random() * Math.PI * 2;
  return {
    x: Math.cos(angle) * TOWN_SPAWN_RADIUS,
    y: Math.sin(angle) * TOWN_SPAWN_RADIUS,
  };
}

/** A client arrival already standing on the town ring can keep that pose. */
export function isTownSquareArrival(position: Position): boolean {
  return Math.abs(Math.hypot(position.x, position.y) - TOWN_SPAWN_RADIUS) < 1;
}

const MATERIAL_POINTS = { ice: 150, metal: 300, rubble: 100 };

/** Each contributor receives the full delivery value. */
export function furnaceReward(rock: Pick<AsteroidData, 'material' | 'size'>): number {
  return MATERIAL_POINTS[rock.material ?? 'rubble'] * Math.max(1, Math.round(rock.size / 25));
}

/** The Town Square is the only pre-lit landmark. */
export function nearestFurnace(position: Position): (typeof FURNACES)[number] {
  return FURNACES.reduce((nearest, site) =>
    Math.hypot(position.x - site.position.x, position.y - site.position.y) <
    Math.hypot(position.x - nearest.position.x, position.y - nearest.position.y)
      ? site
      : nearest
  );
}
