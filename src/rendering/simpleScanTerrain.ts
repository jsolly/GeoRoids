import type { Heightfield } from '../../shared/heightfield';
import { SHIP_ABILITY } from '../../shared/shipKits';
import { TERRAIN } from '../../shared/terrainConfig';
import type { Position } from '../../shared-types';
import { type ContourLevel, extractIsoContours } from '../physics/terrain/contours';
import type { DrawingContext } from './drawingContext';
import type { PlayfieldSize } from './playfieldCamera';

interface Patch {
  field: Heightfield;
  center: Position;
  radius: number;
  levels: ContourLevel[];
}

/** One visual-only coarse patch. It never enters the gameplay contour cache. */
export class SimpleScanTerrain {
  private patch: Patch | null = null;

  reset(): void {
    this.patch = null;
  }

  draw(
    ctx: DrawingContext,
    field: Heightfield,
    viewer: Readonly<Position>,
    viewport: Readonly<PlayfieldSize>,
    scale: number
  ) {
    const halfWidth = viewport.width / (2 * scale);
    const halfHeight = viewport.height / (2 * scale);
    let patch = this.patch;
    let terrainBuilt = false;
    let terrainBuildMs = 0;
    if (
      !patch ||
      patch.field !== field ||
      Math.abs(viewer.x - patch.center.x) + halfWidth > patch.radius ||
      Math.abs(viewer.y - patch.center.y) + halfHeight > patch.radius
    ) {
      const started = performance.now();
      // Cover the complete Scan on entry, so easing through zoom does not rebuild.
      const radius =
        2 **
        Math.ceil(
          Math.log2(Math.max(SHIP_ABILITY.SCAN_RANGE * 1.5, halfWidth * 1.5, halfHeight * 1.5))
        );
      const center = { x: viewer.x, y: viewer.y };
      patch = {
        field,
        center,
        radius,
        levels: extractIsoContours(field, 32, TERRAIN.CONTOUR_INTERVAL * 4, {
          cx: center.x,
          cy: center.y,
          radius,
        }),
      };
      this.patch = patch;
      terrainBuilt = true;
      terrainBuildMs = performance.now() - started;
    }
    let terrainSegments = 0;
    ctx.strokeStyle = '#35515d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const level of patch.levels) {
      for (const segment of level.segments) {
        const ax = (segment.ax - viewer.x) * scale + viewport.width / 2;
        const ay = (segment.ay - viewer.y) * scale + viewport.height / 2;
        const bx = (segment.bx - viewer.x) * scale + viewport.width / 2;
        const by = (segment.by - viewer.y) * scale + viewport.height / 2;
        if (
          Math.max(ax, bx) < 0 ||
          Math.min(ax, bx) > viewport.width ||
          Math.max(ay, by) < 0 ||
          Math.min(ay, by) > viewport.height
        ) {
          continue;
        }
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        terrainSegments++;
      }
    }
    ctx.stroke();
    return {
      terrainBuilt,
      terrainBuildMs,
      terrainSegments,
      terrainSamples: terrainBuilt ? 33 * 33 : 0,
    };
  }
}
