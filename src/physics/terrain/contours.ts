import { type Heightfield, sampleHeight } from './heightfield';
import { TERRAIN } from './terrainConfig';

export interface ContourSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface ContourLevel {
  index: number;
  height: number;
  segments: ContourSegment[];
}

function interp(
  x0: number,
  y0: number,
  h0: number,
  x1: number,
  y1: number,
  h1: number,
  level: number
): { x: number; y: number } {
  const t = (level - h0) / (h1 - h0 || 1e-9);
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
}

function addSegment(
  segments: ContourSegment[],
  a: { x: number; y: number },
  b: { x: number; y: number },
  field: Heightfield
): void {
  const mx = (a.x + b.x) * 0.5 - field.cx;
  const my = (a.y + b.y) * 0.5 - field.cy;
  if (mx * mx + my * my > field.radius * field.radius) {
    return;
  }
  segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
}

/**
 * Marching squares on a regular grid of sampleHeight. Same seed → same lines
 * on every client and the server.
 */
export function extractIsoContours(
  field: Heightfield,
  gridSize: number = TERRAIN.GRID_SIZE,
  levelCount: number = TERRAIN.LEVELS
): ContourLevel[] {
  const n = gridSize;
  const cell = (2 * field.radius) / n;
  const originX = field.cx - field.radius;
  const originY = field.cy - field.radius;
  const dim = n + 1;
  const heights = new Float64Array(dim * dim);

  let minH = Number.POSITIVE_INFINITY;
  let maxH = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      const h = sampleHeight(field, originX + i * cell, originY + j * cell);
      heights[j * dim + i] = h;
      if (h < minH) {
        minH = h;
      }
      if (h > maxH) {
        maxH = h;
      }
    }
  }

  const span = maxH - minH;
  if (!Number.isFinite(span) || span < 1e-6) {
    return [];
  }

  const pad = span * 0.04;
  const levels: ContourLevel[] = [];
  for (let li = 0; li < levelCount; li++) {
    const height = minH + pad + ((span - 2 * pad) * (li + 0.5)) / levelCount;
    const segments: ContourSegment[] = [];

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x0 = originX + i * cell;
        const y0 = originY + j * cell;
        const x1 = x0 + cell;
        const y1 = y0 + cell;
        const h00 = heights[j * dim + i] ?? 0;
        const h10 = heights[j * dim + i + 1] ?? 0;
        const h11 = heights[(j + 1) * dim + i + 1] ?? 0;
        const h01 = heights[(j + 1) * dim + i] ?? 0;

        let code = 0;
        if (h00 >= height) {
          code |= 1;
        }
        if (h10 >= height) {
          code |= 2;
        }
        if (h11 >= height) {
          code |= 4;
        }
        if (h01 >= height) {
          code |= 8;
        }
        if (code === 0 || code === 15) {
          continue;
        }

        const bottom = interp(x0, y0, h00, x1, y0, h10, height);
        const right = interp(x1, y0, h10, x1, y1, h11, height);
        const top = interp(x0, y1, h01, x1, y1, h11, height);
        const left = interp(x0, y0, h00, x0, y1, h01, height);

        switch (code) {
          case 1:
          case 14:
            addSegment(segments, left, bottom, field);
            break;
          case 2:
          case 13:
            addSegment(segments, bottom, right, field);
            break;
          case 3:
          case 12:
            addSegment(segments, left, right, field);
            break;
          case 4:
          case 11:
            addSegment(segments, right, top, field);
            break;
          case 6:
          case 9:
            addSegment(segments, bottom, top, field);
            break;
          case 7:
          case 8:
            addSegment(segments, left, top, field);
            break;
          case 5:
            addSegment(segments, left, top, field);
            addSegment(segments, bottom, right, field);
            break;
          case 10:
            addSegment(segments, left, bottom, field);
            addSegment(segments, top, right, field);
            break;
          default:
            break;
        }
      }
    }

    levels.push({ index: li, height, segments });
  }

  return levels;
}

export function contourSegmentCount(levels: readonly ContourLevel[]): number {
  let count = 0;
  for (const level of levels) {
    count += level.segments.length;
  }
  return count;
}
