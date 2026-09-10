import type { ContourLevel } from '../physics/terrain/contours';

type Segment = ContourLevel['segments'][number];
interface View {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  pad: number;
}
interface LevelIndex {
  cells: Map<number, Map<number, number[]>>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const CELL_SIZE = 256;
// Terrain sessions replace this array when their immutable contour geometry changes.
const cache = new WeakMap<readonly ContourLevel[], LevelIndex[]>();

function buildIndex(level: ContourLevel): LevelIndex {
  const index: LevelIndex = {
    cells: new Map(),
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
  for (const [ordinal, segment] of level.segments.entries()) {
    const { ax, ay, bx, by } = segment;
    const minX = Math.floor(Math.min(ax, bx) / CELL_SIZE);
    const maxX = Math.floor(Math.max(ax, bx) / CELL_SIZE);
    const minY = Math.floor(Math.min(ay, by) / CELL_SIZE);
    const maxY = Math.floor(Math.max(ay, by) / CELL_SIZE);
    index.minX = Math.min(index.minX, minX);
    index.maxX = Math.max(index.maxX, maxX);
    index.minY = Math.min(index.minY, minY);
    index.maxY = Math.max(index.maxY, maxY);
    // Index the whole bounding box: endpoint-only buckets would lose crossing lines.
    for (let x = minX; x <= maxX; x++) {
      let column = index.cells.get(x);
      if (!column) {
        column = new Map();
        index.cells.set(x, column);
      }
      for (let y = minY; y <= maxY; y++) {
        let cell = column.get(y);
        if (!cell) {
          cell = [];
          column.set(y, cell);
        }
        cell.push(ordinal);
      }
    }
  }
  return index;
}

/** Conservative candidates only; the renderer retains its exact screen-space rejection. */
export function contourCandidates(
  levels: readonly ContourLevel[],
  levelOrdinal: number,
  view: View
): readonly Segment[] {
  const level = levels[levelOrdinal];
  if (!level) {
    return [];
  }
  // The normal camera has a finite positive scale. Preserve full-scan behavior otherwise.
  if (
    ![view.x, view.y, view.width, view.height, view.scale, view.pad].every(Number.isFinite) ||
    view.scale <= 0
  ) {
    return level.segments;
  }
  let indices = cache.get(levels);
  if (!indices) {
    indices = levels.map(buildIndex);
    cache.set(levels, indices);
  }
  const index = indices[levelOrdinal];
  if (!index) {
    return level.segments;
  }
  const halfWidth = (view.width / 2 + view.pad) / view.scale;
  const halfHeight = (view.height / 2 + view.pad) / view.scale;
  // Inverting the screen transform can round across a cell boundary. Expand rather
  // than risk dropping a segment that the original screen-space predicate includes.
  const epsilon =
    Number.EPSILON * 16 * Math.max(1, Math.abs(view.x), Math.abs(view.y), halfWidth, halfHeight);
  const minX = Math.max(index.minX, Math.floor((view.x - halfWidth - epsilon) / CELL_SIZE));
  const maxX = Math.min(index.maxX, Math.floor((view.x + halfWidth + epsilon) / CELL_SIZE));
  const minY = Math.max(index.minY, Math.floor((view.y - halfHeight - epsilon) / CELL_SIZE));
  const maxY = Math.min(index.maxY, Math.floor((view.y + halfHeight + epsilon) / CELL_SIZE));
  const ordinals = new Set<number>();
  for (let x = minX; x <= maxX; x++) {
    const column = index.cells.get(x);
    if (!column) {
      continue;
    }
    for (let y = minY; y <= maxY; y++) {
      const cell = column.get(y);
      if (cell) {
        for (const ordinal of cell) {
          ordinals.add(ordinal);
        }
      }
    }
  }
  const candidates: Segment[] = [];
  for (const ordinal of [...ordinals].sort((a, b) => a - b)) {
    const segment = level.segments[ordinal];
    if (segment) {
      candidates.push(segment);
    }
  }
  return candidates;
}
