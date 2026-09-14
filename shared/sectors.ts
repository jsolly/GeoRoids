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
    return [];
  }
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !parseSectorId(entry) || !ids.add(entry)) {
      throw new Error('Saved completed sectors are invalid');
    }
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

function circleOverlapsBounds(position: Position, radius: number, bounds: SectorBounds): boolean {
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

function nearestOpenNeighbor(
  x: number,
  y: number,
  completed: ReadonlySet<string>
): { x: number; y: number } | null {
  for (let radius = 1; radius <= 8; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
          continue;
        }
        const nx = x + dx;
        const ny = y + dy;
        if (!completed.has(sectorId(nx, ny)) && sectorOverlapsWorld(nx, ny)) {
          return { x: nx, y: ny };
        }
      }
    }
  }
  return null;
}

export function containBodyOutOfCompletedSectors(
  body: { position: Position; velocity: Velocity },
  completed: ReadonlySet<string>
): boolean {
  if (completed.size === 0 || !isInsideCompletedSector(body.position, completed)) {
    return false;
  }
  const current = sectorAt(body.position);
  const neighbor = nearestOpenNeighbor(current.x, current.y, completed);
  const bounds = sectorBounds(current.x, current.y);
  let nx = 0;
  let ny = 0;
  if (neighbor) {
    nx = Math.sign(neighbor.x - current.x);
    ny = Math.sign(neighbor.y - current.y);
    if (nx !== 0 && ny !== 0) {
      if (Math.abs(neighbor.x - current.x) >= Math.abs(neighbor.y - current.y)) {
        ny = 0;
      } else {
        nx = 0;
      }
    }
  }
  if (nx === 0 && ny === 0) {
    nx = body.position.x >= 0 ? -1 : 1;
  }
  if (nx !== 0) {
    body.position.x = nx > 0 ? bounds.maxX + WALL_EPSILON : bounds.minX - WALL_EPSILON;
  }
  if (ny !== 0) {
    body.position.y = ny > 0 ? bounds.maxY + WALL_EPSILON : bounds.minY - WALL_EPSILON;
  }
  const vDotN = body.velocity.x * nx + body.velocity.y * ny;
  if (vDotN < 0) {
    body.velocity.x -= 2 * vDotN * nx;
    body.velocity.y -= 2 * vDotN * ny;
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
  return clampInsideWorld(sectorCenter(x, y));
}

function nearestOpenSector(
  origin: Position,
  completed: ReadonlySet<string>
): { x: number; y: number } {
  const start = sectorAt(origin);
  if (!completed.has(start.id) && sectorOverlapsWorld(start.x, start.y)) {
    return start;
  }
  const found = nearestOpenNeighbor(start.x, start.y, completed);
  if (found) {
    return found;
  }
  return { x: 0, y: 0 };
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
    return options.previous;
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
