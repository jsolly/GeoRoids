import type { Heightfield } from '../../shared/heightfield';
import { getTerrainField } from '../../shared/terrainField';
import type { Position } from '../../shared-types';
import { clientPerformance, type SceneryFrame } from '../diagnostics/performanceMetrics';
import { peekBuiltContourRegion } from '../physics/terrain/terrainSession';
import { paintOpaqueBackground } from './canvasBackground';
import { drawContourLayers } from './contourRenderer';
import { createContourQuery } from './contourSpatialIndex';
import { drawStarLayers } from './nativeStarPainter';
import type { PlayfieldSize } from './playfieldCamera';
import { discardRasterSurface, prepareRasterSurface, type RasterSurface } from './rasterSurface';
import { visibleStarTiles } from './starfield';

export const SCAN_SCENERY_MAX_PIXELS = 8_000_000;
const MAX_DIMENSION = 4096;
const PAN_MARGIN = 128;
const SOURCE_PAD = 32;

export interface ScanSceneryCamera {
  readonly screen: Readonly<PlayfieldSize>;
  readonly viewport: Readonly<PlayfieldSize>;
  readonly zoom: number;
  readonly wideZoom: number;
  readonly dpr: number;
  readonly scale: number;
}

interface Projection {
  field: Heightfield;
  width: number;
  height: number;
  zoom: number;
  dpr: number;
  scale: number;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Buffer {
  surface: RasterSurface;
  bounds: Bounds;
  usable: Bounds;
  density: number;
  center: Position;
  refreshDistance: number;
}

type Fallback = Extract<SceneryFrame, { kind: 'fallback' }>;
type State =
  | { kind: 'idle' }
  | { kind: 'ready'; buffer: Buffer }
  | { kind: 'disabled'; reason: Fallback['reason'] }
  | { kind: 'disposed' };

/** Diagnostic prototype only; ordinary sessions retain the existing renderer. */
export function scanSceneryMode(search: string): 'native' | 'cache' {
  const params = new URLSearchParams(search);
  if (!['1', 'collect'].includes(params.get('performance') ?? '')) {
    return 'native';
  }
  const requested = params.get('scanScenery');
  if (requested === null || requested === 'native') {
    return 'native';
  }
  if (requested !== 'cache') {
    throw new Error('scanScenery must be native or cache');
  }
  return requested;
}

function contains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  );
}

/** One world-anchored rear image. Moving entities never enter its backing store. */
export class ScanSceneryCache {
  private state: State = { kind: 'idle' };
  private projection: Projection | null = null;
  private pixels = 0;
  private peakPixels = 0;
  private sourceRadius = 0;
  private readonly candidates = createContourQuery();

  getStats() {
    return {
      ownedPixels: this.pixels,
      peakOwnedPixels: this.peakPixels,
      sourceRadius: this.sourceRadius,
    };
  }

  reset(): void {
    this.releaseReady();
    this.projection = null;
    this.sourceRadius = 0;
    if (this.state.kind !== 'disposed') {
      this.state = { kind: 'idle' };
    }
  }

  dispose(): void {
    this.reset();
    this.state = { kind: 'disposed' };
  }

  draw(
    context: CanvasRenderingContext2D,
    position: Position,
    camera: ScanSceneryCamera
  ): SceneryFrame {
    if (this.state.kind === 'disposed') {
      return { kind: 'fallback', reason: 'disabled' };
    }
    const field = getTerrainField();
    const previous = this.projection;
    if (
      !previous ||
      previous.field !== field ||
      previous.width !== camera.screen.width ||
      previous.height !== camera.screen.height ||
      previous.zoom !== camera.wideZoom ||
      previous.dpr !== camera.dpr ||
      previous.scale !== camera.scale
    ) {
      this.reset();
      this.projection = {
        field,
        width: camera.screen.width,
        height: camera.screen.height,
        zoom: camera.wideZoom,
        dpr: camera.dpr,
        scale: camera.scale,
      };
    }
    if (this.state.kind === 'disabled') {
      return { kind: 'fallback', reason: this.state.reason };
    }
    const currentView = {
      left: position.x - camera.viewport.width / (2 * camera.scale),
      top: position.y - camera.viewport.height / (2 * camera.scale),
      right: position.x + camera.viewport.width / (2 * camera.scale),
      bottom: position.y + camera.viewport.height / (2 * camera.scale),
    };
    const ready = this.state.kind === 'ready' ? this.state.buffer : undefined;
    const covered = ready !== undefined && contains(ready.usable, currentView);
    const needsBuild =
      !ready ||
      !covered ||
      Math.max(Math.abs(position.x - ready.center.x), Math.abs(position.y - ready.center.y)) >=
        ready.refreshDistance;
    let built = false;
    if (needsBuild) {
      const candidate = this.build(position, camera);
      if ('kind' in candidate) {
        if (!covered || this.state.kind !== 'ready') {
          return candidate;
        }
      } else {
        this.releaseReady();
        this.state = { kind: 'ready', buffer: candidate };
        built = true;
      }
    }
    if (this.state.kind !== 'ready') {
      return { kind: 'fallback', reason: 'coverage' };
    }
    const buffer = this.state.buffer;
    if (!contains(buffer.usable, currentView)) {
      return { kind: 'fallback', reason: 'coverage' };
    }
    if (buffer.surface.context.isContextLost?.()) {
      return this.disable('allocation');
    }
    context.save();
    try {
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.filter = 'none';
      context.imageSmoothingEnabled = true;
      context.drawImage(
        buffer.surface.canvas,
        camera.viewport.width / 2 + (buffer.bounds.left - position.x) * camera.scale,
        camera.viewport.height / 2 + (buffer.bounds.top - position.y) * camera.scale,
        (buffer.surface.canvas.width / buffer.density) * camera.scale,
        (buffer.surface.canvas.height / buffer.density) * camera.scale
      );
    } catch {
      return this.disable('composite');
    } finally {
      context.restore();
    }
    return built ? { kind: 'built', cause: ready ? 'pan' : 'cold' } : { kind: 'cached' };
  }

  private build(position: Position, camera: ScanSceneryCamera): Buffer | Fallback {
    const observing = clientPerformance.enabled;
    const started = observing ? performance.now() : 0;
    const width = camera.screen.width / (camera.wideZoom * camera.scale);
    const height = camera.screen.height / (camera.wideZoom * camera.scale);
    const density = camera.wideZoom * camera.scale * camera.dpr;
    if (!(density > 0) || ![width, height, density].every(Number.isFinite)) {
      return this.disable('unsupported');
    }
    // Read only: a cold miss leaves marching and prefetch to the existing rear path.
    const source = peekBuiltContourRegion(
      position,
      Math.hypot(width / 2, height / 2) + SOURCE_PAD / camera.scale
    );
    if (!source) {
      return { kind: 'fallback', reason: 'source' };
    }
    this.sourceRadius = source.bounds.radius;
    const guard = 2 / density;
    const sourceBounds = {
      left: source.bounds.cx - source.bounds.radius,
      top: source.bounds.cy - source.bounds.radius,
      right: source.bounds.cx + source.bounds.radius,
      bottom: source.bounds.cy + source.bounds.radius,
    };
    const margin = Math.min(
      PAN_MARGIN,
      position.x - width / 2 - sourceBounds.left - guard - 1 / density,
      position.y - height / 2 - sourceBounds.top - guard - 1 / density,
      sourceBounds.right - position.x - width / 2 - guard - 1 / density,
      sourceBounds.bottom - position.y - height / 2 - guard - 1 / density
    );
    if (margin < 0) {
      return { kind: 'fallback', reason: 'coverage' };
    }
    const leftPixel = Math.floor((position.x - width / 2 - margin - guard) * density);
    const topPixel = Math.floor((position.y - height / 2 - margin - guard) * density);
    const rightPixel = Math.ceil((position.x + width / 2 + margin + guard) * density);
    const bottomPixel = Math.ceil((position.y + height / 2 + margin + guard) * density);
    const bounds = {
      left: leftPixel / density,
      top: topPixel / density,
      right: rightPixel / density,
      bottom: bottomPixel / density,
    };
    if (!contains(sourceBounds, bounds)) {
      return { kind: 'fallback', reason: 'coverage' };
    }
    const pixelWidth = rightPixel - leftPixel;
    const pixelHeight = bottomPixel - topPixel;
    if (pixelWidth > MAX_DIMENSION || pixelHeight > MAX_DIMENSION) {
      return this.disable('dimension-limit');
    }
    const pixels = pixelWidth * pixelHeight;
    if (pixels + this.pixels > SCAN_SCENERY_MAX_PIXELS) {
      return this.disable('pixel-limit');
    }
    let surface: RasterSurface;
    try {
      surface = prepareRasterSurface(
        pixelWidth,
        pixelHeight,
        undefined,
        'Scan scenery canvas context unavailable'
      );
    } catch {
      if (observing) {
        clientPerformance.record('scanSceneryBuildMs', performance.now() - started);
      }
      return this.disable('allocation');
    }
    this.pixels += pixels;
    this.peakPixels = Math.max(this.peakPixels, this.pixels);
    const center = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    const viewport = { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
    try {
      const paint = surface.context;
      paintOpaqueBackground(paint);
      paint.setTransform(density, 0, 0, density, 0, 0);
      drawStarLayers(paint, visibleStarTiles(center, viewport, 1), center, viewport, 1);
      const levels = source.levels.map((level, ordinal) => ({
        index: level.index,
        segments: this.candidates(source.levels, ordinal, {
          ...center,
          ...viewport,
          scale: 1,
          pad: 0,
        }),
      }));
      drawContourLayers(paint, center, viewport, 1, levels);
    } catch {
      this.release(surface);
      return this.disable('paint');
    } finally {
      if (observing) {
        clientPerformance.record('scanSceneryBuildMs', performance.now() - started);
      }
    }
    return {
      surface,
      bounds,
      usable: {
        left: bounds.left + guard,
        top: bounds.top + guard,
        right: bounds.right - guard,
        bottom: bounds.bottom - guard,
      },
      density,
      center,
      refreshDistance: Math.max(1 / density, margin / 2),
    };
  }

  private disable(reason: Fallback['reason']): Fallback {
    this.releaseReady();
    this.state = { kind: 'disabled', reason };
    return { kind: 'fallback', reason };
  }

  private releaseReady(): void {
    if (this.state.kind === 'ready') {
      this.release(this.state.buffer.surface);
      this.state = { kind: 'idle' };
    }
  }

  private release(surface: RasterSurface): void {
    this.pixels -= surface.canvas.width * surface.canvas.height;
    discardRasterSurface(surface);
  }
}
