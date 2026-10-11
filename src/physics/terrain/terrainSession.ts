import type { Heightfield } from '../../../shared/heightfield';
import { TERRAIN } from '../../../shared/terrainConfig';
import { getTerrainField } from '../../../shared/terrainField';
import type { Position } from '../../../shared-types';
import { warmContourSpatialIndex } from '../../rendering/contourSpatialIndex';
import { type ContourBounds, type ContourLevel, extractIsoContours } from './contours';

// Contour drawings derived from the shared room heightfield. They belong to
// the field they were marched from: a new field (applyTerrainSeed on reconnect)
// drops every patch and any pending prefetch.
interface ContourCache {
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

let cache: ContourCache | null = null;
const contourPatches = new Map<string, ContourPatch>();
let contourPatchBuilds = 0;
let contourPatchAccess = 0;
let prefetchTimer: ReturnType<typeof setTimeout> | undefined;

// A large world needs a local contour patch. Overlap between adjacent patches
// keeps the camera from seeing a gap when it crosses a patch boundary.
export const CONTOUR_REGION_STEP = 1024;
const CONTOUR_REGION_RADIUS = 1536;
const CONTOUR_REGION_GRID_SIZE = 96;
const EAGER_CONTOUR_RADIUS = 8000;
const MAX_CONTOUR_PATCHES = 9;

function regionKey(region: ContourRegion): string {
  return `${region.cx}:${region.cy}:${region.radius}:${region.gridSize}`;
}

export function stopTerrainPrefetch(): void {
  if (prefetchTimer !== undefined) {
    clearTimeout(prefetchTimer);
    prefetchTimer = undefined;
  }
}

function clearContourPatches(): void {
  stopTerrainPrefetch();
  contourPatches.clear();
  contourPatchBuilds = 0;
  contourPatchAccess = 0;
}

/** The contour cache for the current shared field, discarding drawings of a replaced field. */
function syncContourCache(): ContourCache {
  const field = getTerrainField();
  if (cache?.field !== field) {
    clearContourPatches();
    cache = { field, contours: [], contourRegion: null };
  }
  return cache;
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

function buildContourPatch(field: Heightfield, region: ContourRegion): ContourPatch {
  contourPatchBuilds += 1;
  const levels = extractIsoContours(field, region.gridSize, TERRAIN.CONTOUR_INTERVAL, region);
  warmContourSpatialIndex(levels);
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
    if (syncContourCache().field !== field) {
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

export function getTerrainContours(center?: Position, viewRadius?: number): ContourLevel[] {
  const current = syncContourCache();
  const field = current.field;
  if (fieldRadiusIsSmallEnoughForFullContours(field)) {
    if (!current.contourRegion) {
      current.contours = extractIsoContours(field);
      current.contourRegion = {
        cx: field.cx,
        cy: field.cy,
        radius: field.radius,
        gridSize: TERRAIN.GRID_SIZE,
      };
    }
    return current.contours;
  }

  const requestedCenter = center ?? { x: field.cx, y: field.cy };
  const region = contourRegionFor(requestedCenter, viewRadius);
  const previous = current.contourRegion;
  if (
    previous &&
    previous.cx === region.cx &&
    previous.cy === region.cy &&
    previous.radius === region.radius &&
    previous.gridSize === region.gridSize
  ) {
    scheduleNeighborPrefetch(field, region, requestedCenter);
    return current.contours;
  }

  const patch = loadContourPatch(field, region);
  current.contours = patch.levels;
  current.contourRegion = region;
  scheduleNeighborPrefetch(field, region, requestedCenter);
  return patch.levels;
}

function fieldRadiusIsSmallEnoughForFullContours(field: Heightfield): boolean {
  return field.radius <= EAGER_CONTOUR_RADIUS;
}

/** Test helper: how many local contour patches were marched for the current terrain. */
export function builtContourPatchCount() {
  syncContourCache();
  return contourPatchBuilds;
}

/** Test helper: levels already marched for this view, without building or warming. */
export function peekBuiltContourPatch(
  center: Position,
  viewRadius?: number
): ContourLevel[] | undefined {
  if (fieldRadiusIsSmallEnoughForFullContours(syncContourCache().field)) {
    return undefined;
  }
  const region = contourRegionFor(center, viewRadius);
  return contourPatches.get(regionKey(region))?.levels;
}
