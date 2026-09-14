import type { Position } from '../../../shared-types';
import { getGameBoundary } from '../boundary';
import { type ContourBounds, type ContourLevel, extractIsoContours } from './contours';
import { createHeightfield, type Heightfield } from './heightfield';
import { TERRAIN } from './terrainConfig';

interface TerrainCache {
  field: Heightfield;
  contours: ContourLevel[];
  contourRegion: ContourRegion | null;
}

interface ContourRegion extends ContourBounds {
  gridSize: number;
}

let cache: TerrainCache | null = null;

// A large world needs a local contour patch. Overlap between adjacent patches
// keeps the camera from seeing a gap when it crosses a patch boundary.
const CONTOUR_REGION_STEP = 1024;
const CONTOUR_REGION_RADIUS = 1536;
const CONTOUR_REGION_GRID_SIZE = 96;
const EAGER_CONTOUR_RADIUS = 8000;

function boundsFromWorld(): { cx: number; cy: number; radius: number } {
  const boundary = getGameBoundary();
  return { cx: boundary.cx, cy: boundary.cy, radius: boundary.radius };
}

export function ensureTerrain(
  seed: number = TERRAIN.DEFAULT_SEED,
  bounds = boundsFromWorld()
): Heightfield {
  if (
    cache &&
    cache.field.seed === seed &&
    cache.field.cx === bounds.cx &&
    cache.field.cy === bounds.cy &&
    cache.field.radius === bounds.radius
  ) {
    return cache.field;
  }

  const field = createHeightfield(seed, bounds);
  const eagerContours = bounds.radius <= EAGER_CONTOUR_RADIUS;
  cache = {
    field,
    contours: eagerContours ? extractIsoContours(field) : [],
    contourRegion: eagerContours
      ? { cx: bounds.cx, cy: bounds.cy, radius: bounds.radius, gridSize: TERRAIN.GRID_SIZE }
      : null,
  };
  return field;
}

export function getTerrainField(): Heightfield {
  return cache?.field ?? ensureTerrain();
}

export function getTerrainContours(center?: Position, viewRadius?: number): ContourLevel[] {
  if (!cache) {
    ensureTerrain();
  }
  if (!cache) {
    return [];
  }

  const field = cache.field;
  if (fieldRadiusIsSmallEnoughForFullContours(cache.field)) {
    return cache.contours;
  }

  const requestedCenter = center ?? { x: field.cx, y: field.cy };
  const requestedRadius = Number.isFinite(viewRadius)
    ? Math.max(CONTOUR_REGION_RADIUS, viewRadius ?? CONTOUR_REGION_RADIUS)
    : CONTOUR_REGION_RADIUS;
  const region: ContourRegion = {
    cx: Math.round(requestedCenter.x / CONTOUR_REGION_STEP) * CONTOUR_REGION_STEP,
    cy: Math.round(requestedCenter.y / CONTOUR_REGION_STEP) * CONTOUR_REGION_STEP,
    radius:
      Math.ceil((requestedRadius + CONTOUR_REGION_STEP / 2) / CONTOUR_REGION_STEP) *
      CONTOUR_REGION_STEP,
    gridSize: CONTOUR_REGION_GRID_SIZE,
  };
  const previous = cache.contourRegion;
  if (
    previous &&
    previous.cx === region.cx &&
    previous.cy === region.cy &&
    previous.radius === region.radius &&
    previous.gridSize === region.gridSize
  ) {
    return cache.contours;
  }

  cache.contours = extractIsoContours(field, region.gridSize, TERRAIN.LEVELS, region);
  cache.contourRegion = region;
  return cache.contours;
}

function fieldRadiusIsSmallEnoughForFullContours(field: Heightfield): boolean {
  return field.radius <= EAGER_CONTOUR_RADIUS;
}

export function getTerrainSeed(): number {
  return cache?.field.seed ?? TERRAIN.DEFAULT_SEED;
}

export function applyTerrainSeed(seed: number | undefined): Heightfield {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    return ensureTerrain();
  }
  return ensureTerrain(seed >>> 0);
}
