import type { ExplorationTile, Position, Velocity } from '../shared-types';
import { explorationCellAt, isCellExplored } from './exploration';
import { parseSectorId, sectorAt, sectorId, WORLD } from './world';

const CELLS_PER_SECTOR = 16;
const CELL_SIZE = WORLD.sectorSize / CELLS_PER_SECTOR;
const WALL_EPSILON = 1e-4;

interface SectorBounds {
  x: number;
  y: number;
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface SectorWallImpact {
  point: Position;
  normal: Position;
  distance: number;
}

export function sectorBounds(x: number, y: number): SectorBounds {
  return {
    x,
    y,
    id: sectorId(x, y),
    minX: x * WORLD.sectorSize,
    minY: y * WORLD.sectorSize,
    maxX: (x + 1) * WORLD.sectorSize,
    maxY: (y + 1) * WORLD.sectorSize,
  };
}

function sectorCenter(x: number, y: number): Position {
  return {
    x: (x + 0.5) * WORLD.sectorSize,
    y: (y + 0.5) * WORLD.sectorSize,
  };
}

function sectorOverlapsWorld(x: number, y: number): boolean {
  const bounds = sectorBounds(x, y);
  const nearestX = Math.min(bounds.maxX, Math.max(bounds.minX, 0));
  const nearestY = Math.min(bounds.maxY, Math.max(bounds.minY, 0));
  return Math.hypot(nearestX, nearestY) <= WORLD.radius;
}

export function readCompletedSectorIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Saved completed sectors are invalid');
  }
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !parseSectorId(entry) || ids.has(entry)) {
      throw new Error('Saved completed sectors are invalid');
    }
    ids.add(entry);
  }
  return [...ids].sort();
}

export function isSectorExplorationComplete(
  tiles: readonly ExplorationTile[],
  x: number,
  y: number
): boolean {
  let explorable = 0;
  for (let row = 0; row < CELLS_PER_SECTOR; row++) {
    for (let col = 0; col < CELLS_PER_SECTOR; col++) {
      const position = {
        x: x * WORLD.sectorSize + (col + 0.5) * CELL_SIZE,
        y: y * WORLD.sectorSize + (row + 0.5) * CELL_SIZE,
      };
      if (Math.hypot(position.x, position.y) > WORLD.radius) {
        continue;
      }
      const cell = explorationCellAt(position);
      if (cell === null) {
        continue;
      }
      explorable += 1;
      if (!isCellExplored(tiles, cell)) {
        return false;
      }
    }
  }
  return explorable > 0;
}

export function isInsideCompletedSector(
  position: Position,
  completed: ReadonlySet<string>
): boolean {
  return completed.has(sectorAt(position).id);
}

export function circleOverlapsBounds(
  position: Position,
  radius: number,
  bounds: SectorBounds
): boolean {
  const nearestX = Math.min(bounds.maxX, Math.max(bounds.minX, position.x));
  const nearestY = Math.min(bounds.maxY, Math.max(bounds.minY, position.y));
  return Math.hypot(position.x - nearestX, position.y - nearestY) < radius;
}

export function shipOverlapsCompletedSector(
  position: Position,
  radius: number,
  completed: ReadonlySet<string>
): boolean {
  if (completed.size === 0) {
    return false;
  }
  const current = sectorAt(position);
  for (let y = current.y - 1; y <= current.y + 1; y++) {
    for (let x = current.x - 1; x <= current.x + 1; x++) {
      const id = sectorId(x, y);
      if (completed.has(id) && circleOverlapsBounds(position, radius, sectorBounds(x, y))) {
        return true;
      }
    }
  }
  return false;
}

function segmentAabbEntry(
  start: Position,
  end: Position,
  bounds: SectorBounds
): SectorWallImpact | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return null;
  }
  let tMin = 0;
  let tMax = 1;
  let nx = 0;
  let ny = 0;
  const slabs: Array<{ min: number; max: number; start: number; delta: number; axis: 0 | 1 }> = [
    { min: bounds.minX, max: bounds.maxX, start: start.x, delta: dx, axis: 0 },
    { min: bounds.minY, max: bounds.maxY, start: start.y, delta: dy, axis: 1 },
  ];
  for (const slab of slabs) {
    if (Math.abs(slab.delta) < WALL_EPSILON) {
      if (slab.start < slab.min || slab.start > slab.max) {
        return null;
      }
      continue;
    }
    const inverse = 1 / slab.delta;
    let t1 = (slab.min - slab.start) * inverse;
    let t2 = (slab.max - slab.start) * inverse;
    let side = slab.delta > 0 ? -1 : 1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      side = -side;
    }
    if (t1 > tMin) {
      tMin = t1;
      nx = slab.axis === 0 ? side : 0;
      ny = slab.axis === 1 ? side : 0;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) {
      return null;
    }
  }
  if (tMin < 0 || tMin > 1) {
    return null;
  }
  const point = { x: start.x + dx * tMin, y: start.y + dy * tMin };
  if (nx === 0 && ny === 0) {
    return null;
  }
  return { point, normal: { x: nx, y: ny }, distance: tMin * length };
}

export function findSectorWallImpact(
  start: Position,
  end: Position,
  completed: ReadonlySet<string>
): SectorWallImpact | null {
  if (completed.size === 0) {
    return null;
  }
  const startSector = sectorAt(start);
  const endSector = sectorAt(end);
  let nearest: SectorWallImpact | null = null;
  const minX = Math.min(startSector.x, endSector.x) - 1;
  const maxX = Math.max(startSector.x, endSector.x) + 1;
  const minY = Math.min(startSector.y, endSector.y) - 1;
  const maxY = Math.max(startSector.y, endSector.y) + 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!completed.has(sectorId(x, y))) {
        continue;
      }
      const impact = segmentAabbEntry(start, end, sectorBounds(x, y));
      if (impact && (!nearest || impact.distance < nearest.distance)) {
        nearest = impact;
      }
    }
  }
  return nearest;
}

const OPEN_SECTOR_SEARCH_RADIUS = Math.ceil(WORLD.radius / WORLD.sectorSize) + 1;

function nearestWallNormal(position: Position, bounds: SectorBounds): Position {
  const distMinX = position.x - bounds.minX;
  const distMaxX = bounds.maxX - position.x;
  const distMinY = position.y - bounds.minY;
  const distMaxY = bounds.maxY - position.y;
  const nearest = Math.min(distMinX, distMaxX, distMinY, distMaxY);
  if (nearest === distMinX) {
    return { x: -1, y: 0 };
  }
  if (nearest === distMaxX) {
    return { x: 1, y: 0 };
  }
  if (nearest === distMinY) {
    return { x: 0, y: -1 };
  }
  return { x: 0, y: 1 };
}

function overlappedCompletedBounds(
  position: Position,
  radius: number,
  completed: ReadonlySet<string>
): SectorBounds | null {
  const current = sectorAt(position);
  if (completed.has(current.id)) {
    return sectorBounds(current.x, current.y);
  }
  if (radius <= 0) {
    return null;
  }
  for (let y = current.y - 1; y <= current.y + 1; y++) {
    for (let x = current.x - 1; x <= current.x + 1; x++) {
      const bounds = sectorBounds(x, y);
      if (completed.has(bounds.id) && circleOverlapsBounds(position, radius, bounds)) {
        return bounds;
      }
    }
  }
  return null;
}

function nearestOpenNeighbor(
  x: number,
  y: number,
  completed: ReadonlySet<string>,
  bias: Position
): { x: number; y: number } | null {
  const length = Math.hypot(bias.x, bias.y);
  const bx = length > WALL_EPSILON ? bias.x / length : 1;
  const by = length > WALL_EPSILON ? bias.y / length : 0;
  for (let radius = 1; radius <= OPEN_SECTOR_SEARCH_RADIUS; radius++) {
    let best: { x: number; y: number; score: number } | null = null;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
          continue;
        }
        const nx = x + dx;
        const ny = y + dy;
        if (completed.has(sectorId(nx, ny)) || !sectorOverlapsWorld(nx, ny)) {
          continue;
        }
        const score = dx * bx + dy * by - (Math.abs(dx) + Math.abs(dy)) * 0.01;
        if (!best || score > best.score) {
          best = { x: nx, y: ny, score };
        }
      }
    }
    if (best) {
      return best;
    }
  }
  return null;
}

function exitNormal(
  current: { x: number; y: number },
  neighbor: { x: number; y: number },
  completed: ReadonlySet<string>
): Position {
  let nx = Math.sign(neighbor.x - current.x);
  let ny = Math.sign(neighbor.y - current.y);
  if (nx !== 0 && ny !== 0) {
    const eastWestOpen =
      !completed.has(sectorId(current.x + nx, current.y)) &&
      sectorOverlapsWorld(current.x + nx, current.y);
    const northSouthOpen =
      !completed.has(sectorId(current.x, current.y + ny)) &&
      sectorOverlapsWorld(current.x, current.y + ny);
    if (eastWestOpen && !northSouthOpen) {
      ny = 0;
    } else if (northSouthOpen && !eastWestOpen) {
      nx = 0;
    }
  }
  return { x: nx, y: ny };
}

function keepInsideWorld(position: Position, hull: number): Position {
  const limit = WORLD.radius - hull - WALL_EPSILON;
  const radius = Math.hypot(position.x, position.y);
  if (limit <= 0 || radius <= limit || radius === 0) {
    return position;
  }
  const scale = limit / radius;
  return { x: position.x * scale, y: position.y * scale };
}

function ejectOnce(
  body: { position: Position; velocity: Velocity },
  completed: ReadonlySet<string>,
  radius: number,
  bias?: Position
): Position | null {
  const bounds = overlappedCompletedBounds(body.position, radius, completed);
  if (!bounds) {
    return null;
  }
  const inside =
    body.position.x > bounds.minX &&
    body.position.x < bounds.maxX &&
    body.position.y > bounds.minY &&
    body.position.y < bounds.maxY;
  let nx = 0;
  let ny = 0;
  if (inside) {
    const searchBias =
      bias && Math.hypot(bias.x, bias.y) >= WALL_EPSILON
        ? bias
        : nearestWallNormal(body.position, bounds);
    const neighbor = nearestOpenNeighbor(bounds.x, bounds.y, completed, searchBias);
    if (neighbor) {
      const normal = exitNormal(bounds, neighbor, completed);
      nx = normal.x;
      ny = normal.y;
    }
  } else {
    nx = body.position.x < bounds.minX ? -1 : body.position.x > bounds.maxX ? 1 : 0;
    ny = body.position.y < bounds.minY ? -1 : body.position.y > bounds.maxY ? 1 : 0;
  }
  if (nx === 0 && ny === 0) {
    const fallback = nearestWallNormal(body.position, bounds);
    nx = fallback.x;
    ny = fallback.y;
  }
  const clearance = radius + WALL_EPSILON;
  if (nx !== 0) {
    body.position.x = nx > 0 ? bounds.maxX + clearance : bounds.minX - clearance;
  }
  if (ny !== 0) {
    body.position.y = ny > 0 ? bounds.maxY + clearance : bounds.minY - clearance;
  }
  const clamped = keepInsideWorld(body.position, radius);
  body.position.x = clamped.x;
  body.position.y = clamped.y;
  return { x: nx, y: ny };
}

export function containBodyOutOfCompletedSectors(
  body: { position: Position; velocity: Velocity },
  completed: ReadonlySet<string>,
  options?: { radius?: number; bias?: Position }
): boolean {
  const radius = Math.max(0, options?.radius ?? 0);
  if (completed.size === 0) {
    return false;
  }
  let moved = false;
  let reflected = { x: 0, y: 0 };
  for (let step = 0; step < 8; step++) {
    const normal = ejectOnce(body, completed, radius, options?.bias);
    if (!normal) {
      break;
    }
    moved = true;
    reflected = { x: reflected.x + normal.x, y: reflected.y + normal.y };
  }
  if (!moved) {
    return false;
  }
  const length = Math.hypot(reflected.x, reflected.y);
  if (length > 0) {
    const nx = reflected.x / length;
    const ny = reflected.y / length;
    const vDotN = body.velocity.x * nx + body.velocity.y * ny;
    if (vDotN < 0) {
      body.velocity.x -= 2 * vDotN * nx;
      body.velocity.y -= 2 * vDotN * ny;
    }
  }
  return true;
}

function clampInsideWorld(position: Position): Position {
  const radius = Math.hypot(position.x, position.y);
  const limit = WORLD.radius - WORLD.spawnInset;
  if (radius <= limit || radius === 0) {
    return position;
  }
  const scale = limit / radius;
  return { x: position.x * scale, y: position.y * scale };
}

function randomPointInSector(
  x: number,
  y: number,
  random: () => number,
  completed: ReadonlySet<string>
): Position {
  const bounds = sectorBounds(x, y);
  const inset = Math.min(WORLD.spawnInset, WORLD.sectorSize / 2 - 8);
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = clampInsideWorld({
      x: bounds.minX + inset + random() * Math.max(8, bounds.maxX - bounds.minX - inset * 2),
      y: bounds.minY + inset + random() * Math.max(8, bounds.maxY - bounds.minY - inset * 2),
    });
    const insideWorld = Math.hypot(candidate.x, candidate.y) <= WORLD.radius;
    if (!isInsideCompletedSector(candidate, completed) && insideWorld) {
      return candidate;
    }
  }
  const fallback = clampInsideWorld(sectorCenter(x, y));
  if (
    !isInsideCompletedSector(fallback, completed) &&
    Math.hypot(fallback.x, fallback.y) <= WORLD.radius
  ) {
    return fallback;
  }
  throw new Error('No open sector remains for spawn');
}

function nearestOpenSector(
  origin: Position,
  completed: ReadonlySet<string>
): { x: number; y: number } {
  const start = sectorAt(origin);
  if (!completed.has(start.id) && sectorOverlapsWorld(start.x, start.y)) {
    return start;
  }
  const found = nearestOpenNeighbor(start.x, start.y, completed, origin);
  if (found) {
    return found;
  }
  throw new Error('No open sector remains for spawn');
}

export function chooseOpenSectorSpawn(options: {
  completed: ReadonlySet<string>;
  allies?: readonly Position[];
  previous?: Position;
  random: () => number;
}): Position {
  const { completed, random } = options;
  if (
    options.previous &&
    !isInsideCompletedSector(options.previous, completed) &&
    Math.hypot(options.previous.x, options.previous.y) <= WORLD.radius
  ) {
    return { x: options.previous.x, y: options.previous.y };
  }
  const ally = options.allies?.find((position) => !isInsideCompletedSector(position, completed));
  if (ally) {
    const angle = random() * Math.PI * 2;
    const radius = random() * WORLD.spawnClusterRadius;
    const clustered = {
      x: ally.x + Math.cos(angle) * radius,
      y: ally.y + Math.sin(angle) * radius,
    };
    if (!isInsideCompletedSector(clustered, completed)) {
      return clampInsideWorld(clustered);
    }
    const home = sectorAt(ally);
    return randomPointInSector(home.x, home.y, random, completed);
  }
  const origin = options.previous ?? { x: 0, y: 0 };
  const sector = nearestOpenSector(origin, completed);
  return randomPointInSector(sector.x, sector.y, random, completed);
}

export function formatSectorLabel(sector: { x: number; y: number }): string {
  return `${sector.x}, ${sector.y}`;
}
