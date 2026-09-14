import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { getGameBoundary } from '../physics/boundary';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvas';

const starScreen = { x: 0, y: 0 };

interface Star {
  x: number;
  y: number;
  alpha: number;
  fillStyle: string;
}

// Keep deterministic stars only in the camera's visible tiles.
const STAR_TILE_SIZE = 1600;
const STARS_PER_TILE = 32;

// mulberry32: tiny deterministic PRNG so the sky is identical on every client and every frame.
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tileSeed(seed: number, tileX: number, tileY: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ Math.imul(tileX | 0, 0x9e3779b9), 0x85ebca6b);
  value = Math.imul(value ^ Math.imul(tileY | 0, 0xc2b2ae35), 0x27d4eb2f);
  return (value ^ (value >>> 16)) >>> 0;
}

function tileIsOutsideBoundary(
  tileX: number,
  tileY: number,
  centerX: number,
  centerY: number,
  radius: number
): boolean {
  const minX = centerX + tileX * STAR_TILE_SIZE;
  const minY = centerY + tileY * STAR_TILE_SIZE;
  const maxX = minX + STAR_TILE_SIZE;
  const maxY = minY + STAR_TILE_SIZE;
  const nearestX = Math.max(minX, Math.min(centerX, maxX));
  const nearestY = Math.max(minY, Math.min(centerY, maxY));
  return Math.hypot(nearestX - centerX, nearestY - centerY) > radius;
}

function generateStarTile(
  tileX: number,
  tileY: number,
  seed: number,
  centerX: number,
  centerY: number,
  radius: number
): Star[] {
  if (tileIsOutsideBoundary(tileX, tileY, centerX, centerY, radius)) {
    return [];
  }

  const rng = createRng(tileSeed(seed, tileX, tileY));
  const stars: Star[] = [];
  const alphaRange = VISUAL.STAR_ALPHA_MAX - VISUAL.STAR_ALPHA_MIN;
  const originX = centerX + tileX * STAR_TILE_SIZE;
  const originY = centerY + tileY * STAR_TILE_SIZE;
  // A partially clipped edge tile can reject samples outside the circular
  // world. A bounded attempt count keeps a malformed boundary from hanging
  // the render loop.
  for (let attempt = 0; attempt < STARS_PER_TILE * 16 && stars.length < STARS_PER_TILE; attempt++) {
    const x = originX + rng() * STAR_TILE_SIZE;
    const y = originY + rng() * STAR_TILE_SIZE;
    if (Math.hypot(x - centerX, y - centerY) > radius) {
      continue;
    }
    const alpha = VISUAL.STAR_ALPHA_MIN + rng() * alphaRange;
    stars.push({
      x,
      y,
      alpha,
      fillStyle: hexToRgba(PALETTE.STARS, alpha),
    });
  }
  return stars;
}

const cachedTiles = new Map<string, Star[]>();
let cachedWorldKey = '';

function getStarTile(tileX: number, tileY: number): readonly Star[] {
  const boundary = getGameBoundary();
  const worldKey = `${VISUAL.STAR_SEED}:${boundary.cx}:${boundary.cy}:${boundary.radius}`;
  if (cachedWorldKey !== worldKey) {
    cachedWorldKey = worldKey;
    cachedTiles.clear();
  }
  const key = `${tileX},${tileY}`;
  const cached = cachedTiles.get(key);
  if (cached) {
    return cached;
  }
  const stars = generateStarTile(
    tileX,
    tileY,
    VISUAL.STAR_SEED,
    boundary.cx,
    boundary.cy,
    boundary.radius
  );
  cachedTiles.set(key, stars);
  return stars;
}

export function drawStarfield(shipPosition: Position): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }

  const viewport = canvasManager.getViewportSize();
  const size = VISUAL.STAR_SIZE;

  const boundary = getGameBoundary();
  const scale = canvasManager.getPlayfieldScale();
  const halfWidth = viewport.width / (2 * scale);
  const halfHeight = viewport.height / (2 * scale);
  const viewPadding = (size + 1) / scale;
  const minTileX = Math.floor(
    (shipPosition.x - halfWidth - viewPadding - boundary.cx) / STAR_TILE_SIZE
  );
  const maxTileX = Math.floor(
    (shipPosition.x + halfWidth + viewPadding - boundary.cx) / STAR_TILE_SIZE
  );
  const minTileY = Math.floor(
    (shipPosition.y - halfHeight - viewPadding - boundary.cy) / STAR_TILE_SIZE
  );
  const maxTileY = Math.floor(
    (shipPosition.y + halfHeight + viewPadding - boundary.cy) / STAR_TILE_SIZE
  );

  const visibleTiles = new Set<string>();
  const screen = starScreen;
  for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      visibleTiles.add(`${tileX},${tileY}`);
      for (const star of getStarTile(tileX, tileY)) {
        canvasManager.worldToScreenInto(screen, star, shipPosition);
        const sx = screen.x;
        const sy = screen.y;
        if (sx < -size || sy < -size || sx > viewport.width + size || sy > viewport.height + size) {
          continue;
        }
        ctx.fillStyle = star.fillStyle;
        ctx.fillRect((sx + 0.5) | 0, (sy + 0.5) | 0, size, size);
      }
    }
  }
  for (const key of cachedTiles.keys()) {
    if (!visibleTiles.has(key)) {
      cachedTiles.delete(key);
    }
  }
}
