import type { Position } from '../../../shared-types';
import { VISUAL } from '../../constants';
import { warmElevationLabels } from '../../rendering/contourLabels';
import { warmContourSpatialIndex } from '../../rendering/contourSpatialIndex';
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

interface ContourPatch {
  region: ContourRegion;
  levels: ContourLevel[];
  usedAt: number;
}

let cache: TerrainCache | null = null;
const contourPatches = new Map<string, ContourPatch>();
let contourPatchBuilds = 0;
let contourPatchAccess = 0;
let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
let lastRequestedCenter: Position = { x: 0, y: 0 };

// A large world needs a local contour patch. Overlap between adjacent patches
// keeps the camera from seeing a gap when it crosses a patch boundary.
export const CONTOUR_REGION_STEP = 1024;
const CONTOUR_REGION_RADIUS = 1536;
const CONTOUR_REGION_GRID_SIZE = 96;
const EAGER_CONTOUR_RADIUS = 8000;
const MAX_CONTOUR_PATCHES = 9;

function boundsFromWorld(): { cx: number; cy: number; radius: number } {
  const boundary = getGameBoundary();
  return { cx: boundary.cx, cy: boundary.cy, radius: boundary.radius };
}

function regionKey(region: ContourRegion): string {
  return `${region.cx}:${region.cy}:${region.radius}:${region.gridSize}`;
}

function cancelPrefetch(): void {
  if (prefetchTimer !== undefined) {
    clearTimeout(prefetchTimer);
    prefetchTimer = undefined;
  }
}

function clearContourPatches(): void {
  cancelPrefetch();
  contourPatches.clear();
  contourPatchBuilds = 0;
  contourPatchAccess = 0;
}

function evictUnusedContourPatches(): void {
  if (contourPatches.size <= MAX_CONTOUR_PATCHES) {
    return;
  }
  const oldest = [...contourPatches.entries()].sort(
    (left, right) => left[1].usedAt - right[1].usedAt
  );
  for (const [key] of oldest.slice(0, contourPatches.size - MAX_CONTOUR_PATCHES)) {
    contourPatches.delete(key);
  }
}

function touchContourPatch(patch: ContourPatch): ContourPatch {
  contourPatchAccess += 1;
  patch.usedAt = contourPatchAccess;
  return patch;
}

function warmPatchDrawCaches(levels: ContourLevel[]): void {
  warmContourSpatialIndex(levels);
  warmElevationLabels(levels, VISUAL.CONTOUR_LABEL_SPACING);
}

function buildContourPatch(field: Heightfield, region: ContourRegion): ContourPatch {
  contourPatchBuilds += 1;
  const levels = extractIsoContours(field, region.gridSize, TERRAIN.LEVELS, region);
  warmPatchDrawCaches(levels);
  return touchContourPatch({
    region,
    levels,
    usedAt: 0,
  });
}

function loadContourPatch(field: Heightfield, region: ContourRegion): ContourPatch {
  const key = regionKey(region);
  const existing = contourPatches.get(key);
  if (existing) {
    return touchContourPatch(existing);
  }
  const patch = buildContourPatch(field, region);
  contourPatches.set(key, patch);
  evictUnusedContourPatches();
  return patch;
}

function contourRegionFor(center: Position, viewRadius: number | undefined): ContourRegion {
  const requestedRadius = Number.isFinite(viewRadius)
    ? Math.max(CONTOUR_REGION_RADIUS, viewRadius ?? CONTOUR_REGION_RADIUS)
    : CONTOUR_REGION_RADIUS;
  return {
    cx: Math.round(center.x / CONTOUR_REGION_STEP) * CONTOUR_REGION_STEP,
    cy: Math.round(center.y / CONTOUR_REGION_STEP) * CONTOUR_REGION_STEP,
    radius:
      Math.ceil((requestedRadius + CONTOUR_REGION_STEP / 2) / CONTOUR_REGION_STEP) *
      CONTOUR_REGION_STEP,
    gridSize: CONTOUR_REGION_GRID_SIZE,
  };
}

function neighborRegions(region: ContourRegion, center: Position): ContourRegion[] {
  const towardX = center.x - region.cx;
  const towardY = center.y - region.cy;
  const neighbors = [
    { ...region, cx: region.cx + CONTOUR_REGION_STEP },
    { ...region, cx: region.cx - CONTOUR_REGION_STEP },
    { ...region, cy: region.cy + CONTOUR_REGION_STEP },
    { ...region, cy: region.cy - CONTOUR_REGION_STEP },
  ];
  return neighbors.sort(
    (left, right) =>
      (right.cx - region.cx) * towardX +
      (right.cy - region.cy) * towardY -
      ((left.cx - region.cx) * towardX + (left.cy - region.cy) * towardY)
  );
}

function scheduleNeighborPrefetch(
  field: Heightfield,
  region: ContourRegion,
  center: Position
): void {
  if (prefetchTimer !== undefined) {
    return;
  }
  prefetchTimer = setTimeout(() => {
    prefetchTimer = undefined;
    if (!cache || cache.field !== field) {
      return;
    }
    const missing = neighborRegions(region, center).find(
      (candidate) => !contourPatches.has(regionKey(candidate))
    );
    if (!missing) {
      return;
    }
    loadContourPatch(field, missing);
    if (
      neighborRegions(region, center).some((candidate) => !contourPatches.has(regionKey(candidate)))
    ) {
      scheduleNeighborPrefetch(field, region, center);
    }
  }, 0);
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

  clearContourPatches();
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
  lastRequestedCenter = requestedCenter;
  const region = contourRegionFor(requestedCenter, viewRadius);
  const previous = cache.contourRegion;
  if (
    previous &&
    previous.cx === region.cx &&
    previous.cy === region.cy &&
    previous.radius === region.radius &&
    previous.gridSize === region.gridSize
  ) {
    scheduleNeighborPrefetch(field, region, requestedCenter);
    return cache.contours;
  }

  const patch = loadContourPatch(field, region);
  cache.contours = patch.levels;
  cache.contourRegion = region;
  scheduleNeighborPrefetch(field, region, requestedCenter);
  return patch.levels;
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

/** Test helper: how many local contour patches were marched for the current terrain. */
export function builtContourPatchCount(): number {
  return contourPatchBuilds;
}

/** Test helper: finish queued neighbor contour work on the current terrain. */
export function flushContourPrefetch(): void {
  cancelPrefetch();
  if (!cache || fieldRadiusIsSmallEnoughForFullContours(cache.field) || !cache.contourRegion) {
    return;
  }
  const field = cache.field;
  const region = cache.contourRegion;
  for (const neighbor of neighborRegions(region, lastRequestedCenter)) {
    loadContourPatch(field, neighbor);
  }
}
