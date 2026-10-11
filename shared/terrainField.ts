import { getGameBoundary } from './boundary';
import { createHeightfield, type Heightfield } from './heightfield';
import { TERRAIN } from './terrainConfig';

// The room's heightfield. Clients derive contour drawings from it in
// src/physics/terrain/terrainSession.ts; the server only samples it.
let field: Heightfield | null = null;

function boundsFromWorld(): { cx: number; cy: number; radius: number } {
  const boundary = getGameBoundary();
  return { cx: boundary.cx, cy: boundary.cy, radius: boundary.radius };
}

export function ensureTerrain(
  seed: number = TERRAIN.DEFAULT_SEED,
  bounds = boundsFromWorld()
): Heightfield {
  if (
    field &&
    field.seed === seed &&
    field.cx === bounds.cx &&
    field.cy === bounds.cy &&
    field.radius === bounds.radius
  ) {
    return field;
  }
  field = createHeightfield(seed, bounds);
  return field;
}

export function getTerrainField(): Heightfield {
  return field ?? ensureTerrain();
}

export function getTerrainSeed(): number {
  return field?.seed ?? TERRAIN.DEFAULT_SEED;
}

export function applyTerrainSeed(seed: number | undefined): Heightfield {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    return ensureTerrain();
  }
  return ensureTerrain(seed >>> 0);
}
