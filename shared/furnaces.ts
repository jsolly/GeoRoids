import type { AsteroidData, CivicModule, Position } from '../shared-types';
import { oreResource, oreYield } from './economy';
import { WORLD } from './world';

/** Respawn and fresh-join ring around the Town Square grate. */
export const TOWN_SPAWN_RADIUS = 180;

export const TOWN_HEARTH = {
  id: 'town-square',
  name: 'Town Square',
  position: { x: 0, y: 0 },
  radius: 85,
} as const;

/** Always-lit hearths. Furnace lots start dark and join this set when built. */
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

const DIRECTION_NAMES = ['East', 'Northeast', 'North', 'West', 'South', 'Southeast'] as const;
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

function unitHash(seed: number): number {
  let value = seed | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967296;
}

function layoutHash(ring: number, index: number, channel: number): number {
  return unitHash(
    Math.imul(ring + 3, 0x9e3779b1) ^
      Math.imul(index + 11, 0x85ebca6b) ^
      Math.imul(channel + 5, 0xc2b2ae35)
  );
}

/** How far a lot may leave its ring, in world units and degrees. */
const RADIAL_SPREAD: Record<1 | 2 | 3, number> = { 1: 480, 2: 900, 3: 1_400 };
const ANGULAR_SPREAD_DEG: Record<1 | 2 | 3, number> = { 1: 14, 2: 9, 3: 4.5 };

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
  throw new Error(`No furnace lot at radius ${radius}`);
}

function directionIndex(ring: number, index: number): number {
  if (ring === 1) {
    return index;
  }
  if (ring === 2) {
    return Math.floor(index / 2);
  }
  return Math.floor(index / 4);
}

function layoutCivicLots(): CivicLot[] {
  const drafts: Array<Omit<CivicLot, 'name'> & { direction: number }> = [];
  const placed: Position[] = [];
  for (const spec of RINGS) {
    const step = (2 * Math.PI) / spec.count;
    const offset = (spec.offsetDeg * Math.PI) / 180;
    for (let index = 0; index < spec.count; index++) {
      const radial = (layoutHash(spec.ring, index, 0) - 0.5) * 2 * RADIAL_SPREAD[spec.ring];
      const angular =
        ((layoutHash(spec.ring, index, 1) - 0.5) * 2 * ANGULAR_SPREAD_DEG[spec.ring] * Math.PI) /
        180;
      const position = placeOnRing(spec.radius + radial, offset + index * step + angular, placed);
      placed.push(position);
      const direction = directionIndex(spec.ring, index);
      const previousRing = RINGS[RINGS.indexOf(spec) - 1];
      const parentSlot = previousRing ? Math.floor(index / (spec.count / previousRing.count)) : 0;
      // Keep saved furnace IDs stable; pipe routing also hashes these addresses.
      const parentId = previousRing ? `street-${previousRing.ring}-${parentSlot}` : TOWN_HEARTH.id;
      drafts.push({
        id: `street-${spec.ring}-${index}`,
        position,
        radius: TOWN_HEARTH.radius,
        ring: spec.ring,
        cost: spec.cost,
        parentId,
        direction,
      });
    }
  }
  const counts = new Map<string, number>();
  return drafts.map((draft) => {
    const key = `${draft.direction}:${draft.ring}`;
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    const direction = DIRECTION_NAMES[draft.direction] ?? 'Outer';
    const base = `${direction} Furnace ${ROMAN[draft.ring]}`;
    const siblings = drafts.filter(
      (other) => other.direction === draft.direction && other.ring === draft.ring
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

/** How fast a delivery light runs along the furnace pipes, in world units per second. */
export const FURNACE_PIPE_SPEED = 2_400;

const LOT_BY_ID = new Map(CIVIC_LOTS.map((lot) => [lot.id, lot]));

function hearthPosition(id: string): Position | undefined {
  if (id === TOWN_HEARTH.id) {
    return TOWN_HEARTH.position;
  }
  return LOT_BY_ID.get(id)?.position;
}

function routeSalt(fromId: string, toId: string): number {
  let hash = 2166136261;
  const label = `${fromId}>${toId}`;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function appendPoint(path: Position[], point: Position): void {
  const last = path[path.length - 1];
  if (last && last.x === point.x && last.y === point.y) {
    return;
  }
  path.push({ x: point.x, y: point.y });
}

function distanceToSegment(point: Position, start: Position, end: Position): number {
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

/**
 * Playfield underglow is 2.2×2.6 px at 1:1, so the centerline stays this far
 * outside every other grate and the stroke does not paint into that ring.
 */
const PIPE_STROKE_CLEARANCE = 6;

/** A run may enter only its own grate and its parent's, and only on those end segments. */
function tailClearsOtherGrates(from: Position, to: Position, tail: readonly Position[]): boolean {
  const points = [from, ...tail];
  const grates = [TOWN_HEARTH, ...CIVIC_LOTS];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) {
      continue;
    }
    const first = index === 0;
    const last = index === points.length - 2;
    for (const grate of grates) {
      const atFrom = Math.hypot(grate.position.x - from.x, grate.position.y - from.y) < 1;
      const atTo = Math.hypot(grate.position.x - to.x, grate.position.y - to.y) < 1;
      if ((atFrom && first) || (atTo && last)) {
        continue;
      }
      if (distanceToSegment(grate.position, start, end) < grate.radius + PIPE_STROKE_CLEARANCE) {
        return false;
      }
    }
  }
  return true;
}

function orthogonalTail(
  from: Position,
  to: Position,
  split: number,
  side: number,
  jog: number,
  horizontalFirst: boolean
): Position[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const nudge = jog + 80;
  const tail: Position[] = [];
  if (horizontalFirst) {
    const midX = from.x + dx * split;
    let shelfY = from.y + side * jog;
    if (Math.abs(shelfY - from.y) < 1 || Math.abs(shelfY - to.y) < 1) {
      shelfY = from.y + side * nudge;
    }
    appendPoint(tail, { x: midX, y: from.y });
    appendPoint(tail, { x: midX, y: shelfY });
    appendPoint(tail, { x: to.x, y: shelfY });
  } else {
    const midY = from.y + dy * split;
    let shelfX = from.x + side * jog;
    if (Math.abs(shelfX - from.x) < 1 || Math.abs(shelfX - to.x) < 1) {
      shelfX = from.x + side * nudge;
    }
    appendPoint(tail, { x: from.x, y: midY });
    appendPoint(tail, { x: shelfX, y: midY });
    appendPoint(tail, { x: shelfX, y: to.y });
  }
  appendPoint(tail, to);
  return tail;
}

/** Right-angle elbows from `from` (excluded) through `to`, kept out of every other grate. */
function cityBlockTail(from: Position, to: Position, salt: number): Position[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const spanX = Math.abs(dx);
  const spanY = Math.abs(dy);
  if (spanX < 1 && spanY < 1) {
    return [];
  }
  if (spanX < 1 || spanY < 1) {
    const straight = [{ x: to.x, y: to.y }];
    if (tailClearsOtherGrates(from, to, straight)) {
      return straight;
    }
    const long = Math.max(spanX, spanY, TOWN_HEARTH.radius * 4);
    for (const side of [1, -1]) {
      const dogleg = orthogonalTail(from, to, 0.5, side, long * 0.25, spanX >= spanY);
      if (tailClearsOtherGrates(from, to, dogleg)) {
        return dogleg;
      }
    }
    return straight;
  }
  const baseSplit = 0.42 + unitHash(salt) * 0.16;
  const baseSide = unitHash(salt ^ 0x51ed) < 0.5 ? -1 : 1;
  const baseJog = (0.28 + unitHash(salt ^ 0x9d2c) * 0.22) * Math.max(spanX, spanY);
  const preferHorizontal = unitHash(salt ^ 0x17ab) < 0.5;
  let fallback: Position[] = [];
  let chosen: Position[] | undefined;
  let chosenBend = Number.POSITIVE_INFINITY;
  for (const horizontalFirst of [preferHorizontal, !preferHorizontal]) {
    for (const side of [baseSide, -baseSide]) {
      for (const split of [baseSplit, 0.3, 0.55, 0.72]) {
        for (const jog of [baseJog, baseJog * 0.55, baseJog * 1.35, Math.max(spanX, spanY) * 0.5]) {
          const tail = orthogonalTail(from, to, split, side, jog, horizontalFirst);
          if (fallback.length === 0) {
            fallback = tail;
          }
          if (!tailClearsOtherGrates(from, to, tail)) {
            continue;
          }
          const bend = tail.reduce(
            (best, point) => Math.max(best, distanceToSegment(point, from, to)),
            0
          );
          if (bend < chosenBend) {
            chosen = tail;
            chosenBend = bend;
          }
        }
      }
    }
  }
  return chosen ?? fallback;
}

function buildPipeHops(): Map<string, readonly Position[]> {
  const hops = new Map<string, readonly Position[]>();
  for (const lot of CIVIC_LOTS) {
    const parent = hearthPosition(lot.parentId);
    if (!parent) {
      continue;
    }
    const path: Position[] = [{ x: lot.position.x, y: lot.position.y }];
    for (const point of cityBlockTail(lot.position, parent, routeSalt(lot.id, lot.parentId))) {
      appendPoint(path, point);
    }
    hops.set(lot.id, path);
  }
  return hops;
}

const PIPE_HOPS = buildPipeHops();

/** Grate-to-parent run, including both ends. Empty when the lot is unknown. */
export function pipeHopToParent(lotId: string): readonly Position[] {
  return PIPE_HOPS.get(lotId) ?? [];
}

/**
 * Right-angle run from the furnace that took the delivery back to Town Square.
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
    const hop = PIPE_HOPS.get(id);
    const lot = LOT_BY_ID.get(id);
    if (!hop || hop.length < 2 || !lot) {
      return [];
    }
    const points = path.length === 0 ? hop : hop.slice(1);
    for (const point of points) {
      appendPoint(path, point);
    }
    id = lot.parentId;
  }
  return path;
}

export function civicLot(id: string): CivicLot | undefined {
  return LOT_BY_ID.get(id);
}

/** Nearest furnace lot whose center is within `reach` world units. */
export function civicLotWithin(position: Position, reach: number): CivicLot | undefined {
  let found: CivicLot | undefined;
  let best = reach;
  for (const lot of CIVIC_LOTS) {
    const distance = Math.hypot(position.x - lot.position.x, position.y - lot.position.y);
    if (distance <= best) {
      found = lot;
      best = distance;
    }
  }
  return found;
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

/** Display name of a furnace paid for by one Scout. */
export function civicModuleName(builderName: string, furnaceName: string): string {
  const builder = builderName.trim().replace(/\s+/gu, ' ');
  if (!builder) {
    return furnaceName;
  }
  return `${builder}'s ${furnaceName}`;
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

function validModuleBuilderId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
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
    const built = row as { id?: unknown; builderName?: unknown; builderId?: unknown };
    if (typeof built.id !== 'string' || ids.has(built.id) || !LOT_BY_ID.has(built.id)) {
      return false;
    }
    if (typeof built.builderName !== 'string' || !MODULE_BUILDER_NAME.test(built.builderName)) {
      return false;
    }
    if ('builderId' in built && !validModuleBuilderId(built.builderId)) {
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

const MATERIAL_POINTS = { ice: 15, metal: 30, rubble: 10, crystal: 60 };

/** Each contributor receives the full delivery value. */
export function furnaceReward(
  rock: Pick<AsteroidData, 'id' | 'material' | 'size' | 'ore'>
): number {
  const resource = oreResource(rock);
  return resource ? MATERIAL_POINTS[resource] * oreYield(rock) : Math.max(1, oreYield(rock));
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
