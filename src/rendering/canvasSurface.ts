import type { Position } from '../../shared-types';
import { clientPerformance } from '../diagnostics/performanceMetrics';
import { Point } from '../physics/Point';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { paintOpaqueBackground } from './canvasBackground';
import { watchDevicePixelRatio } from './devicePixelRatioWatcher';
import { type GpuContourLayer, GpuRearRenderer } from './gpuRearRenderer';
import {
  clearHudLayoutCache,
  hudLayoutForCanvas,
  refreshHudLayoutForCanvas,
} from './hud/hudLayout';
import { drawStarLayers, type StarPoint } from './nativeStarPainter';
import {
  PLAYFIELD_CLOSE_SCALE,
  type PlayfieldSize,
  projectWorldToScreenInto,
} from './playfieldCamera';
import { configureRenderQuality } from './renderQuality';
import { rotateVectorInto, travelCameraRotation } from './travelCamera';

const TOGGLE_STEP_PX = 52;
/** Time constants for the camera easing out to a wide view and back to flight. */
const CAMERA_ZOOM_OUT_SECONDS = 0.14;
const CAMERA_ZOOM_IN_SECONDS = 0.2;

/** Map, Inventory, and Store tops. Short touch screens keep Inventory under the radar. */
export function playfieldToggleOffsets(
  miniMap: { y: number; size: number },
  touchControls: boolean,
  height: number
): { mapY: number; schematicY: number; storeY: number } {
  if (touchControls && height < 500) {
    const schematicY = miniMap.y + miniMap.size + 8;
    return {
      mapY: schematicY + TOGGLE_STEP_PX,
      schematicY,
      storeY: schematicY + TOGGLE_STEP_PX * 2,
    };
  }
  const mapY = miniMap.y - 84;
  return {
    mapY,
    schematicY: mapY - TOGGLE_STEP_PX,
    storeY: mapY - TOGGLE_STEP_PX * 2,
  };
}

/** Canvas DOM, viewport, and world/screen mapping. Scene composition lives in `canvas.ts`
 * so entity/HUD painters can import this module without forming an import cycle. */
class CanvasManager {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private resizeHandler: (() => void) | null = null;
  private resizeFrame: number | null = null;
  private stopDevicePixelRatioWatcher: (() => void) | null = null;
  private readonly viewport = { width: 1, height: 1 };
  private devicePixelRatio = 1;
  private cameraRotation = 0;
  private zoom = 1;
  private zoomUpdatedAt: number | null = null;
  private readonly screenViewport = { width: 1, height: 1 };
  private worldLayersZoomed = false;
  private readonly screenPos = { x: 0, y: 0 };
  private gpuRenderer: GpuRearRenderer | null = null;
  private gpuFrameActive = false;
  private inputMediaQueries: MediaQueryList[] = [];

  initialize(): void {
    if (this.canvas) {
      this.destroy();
    }
    this.canvas = document.querySelector('#gameCanvas') as HTMLCanvasElement | null;
    const gpuRequested = new URLSearchParams(window.location.search).get('renderer') === 'webgl2';
    this.context = this.canvas?.getContext('2d', { alpha: false }) || null;

    if (this.canvas && this.context) {
      if (gpuRequested) {
        try {
          this.gpuRenderer = GpuRearRenderer.create(this.canvas, () => {
            if (!this.gpuRenderer?.available()) {
              this.gpuFrameActive = false;
            }
          });
        } catch {
          this.gpuRenderer = null;
        }
      }
      this.resizeHandler = () => {
        if (this.resizeFrame !== null) {
          return;
        }
        if (typeof window.requestAnimationFrame !== 'function') {
          this.handleCanvasResize();
          return;
        }
        this.resizeFrame = window.requestAnimationFrame(() => {
          this.resizeFrame = null;
          this.handleCanvasResize();
        });
      };
      window.addEventListener('resize', this.resizeHandler);
      window.visualViewport?.addEventListener('resize', this.resizeHandler);
      window.visualViewport?.addEventListener('scroll', this.resizeHandler);
      const onResize = this.resizeHandler;
      this.inputMediaQueries = ['(pointer: coarse)', '(hover: none)'].map((query) => {
        const media = window.matchMedia(query);
        media.addEventListener('change', onResize);
        return media;
      });

      this.stopDevicePixelRatioWatcher = watchDevicePixelRatio(() => {
        this.handleCanvasResize();
      });

      this.handleCanvasResize();
      clientPerformance.setRendererObservation(gpuRequested ? 'webgl2' : 'canvas', () => ({
        backend: this.getRendererBackend(),
        gpuStats: this.getGpuFrameStats(),
      }));
    }
  }

  private viewportSize(): { width: number; height: number } {
    const vv = window.visualViewport;
    return {
      width: Math.max(1, Math.round(vv?.width ?? window.innerWidth)),
      height: Math.max(1, Math.round(vv?.height ?? window.innerHeight)),
    };
  }

  private currentDevicePixelRatio(): number {
    const dpr = window.devicePixelRatio;
    return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  }

  private applyViewportSize(): boolean {
    if (!this.canvas) {
      return false;
    }
    const { width, height } = this.viewportSize();
    const deviceDpr = this.currentDevicePixelRatio();
    const touchControls = shouldUseTouchControls();
    const quality = configureRenderQuality(window.location.search, touchControls);
    const dpr = quality.maxDpr === 'native' ? deviceDpr : Math.min(deviceDpr, quality.maxDpr);
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    const backingSizeChanged =
      this.canvas.width !== backingWidth || this.canvas.height !== backingHeight;
    const devicePixelRatioChanged = this.devicePixelRatio !== dpr;

    this.viewport.width = width;
    this.viewport.height = height;

    const { miniMap } = refreshHudLayoutForCanvas(this.viewport);
    this.syncPlayfieldChrome(width, height, miniMap, touchControls);

    if (this.canvas.width !== backingWidth) {
      this.canvas.width = backingWidth;
    }
    if (this.canvas.height !== backingHeight) {
      this.canvas.height = backingHeight;
    }

    const cssWidth = `${width}px`;
    const cssHeight = `${height}px`;
    if (this.canvas.style.width !== cssWidth) {
      this.canvas.style.width = cssWidth;
    }
    if (this.canvas.style.height !== cssHeight) {
      this.canvas.style.height = cssHeight;
    }
    this.gpuRenderer?.resizeSurface(width, height, dpr);

    if (backingSizeChanged || devicePixelRatioChanged) {
      this.context?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.devicePixelRatio = dpr;
    clientPerformance.setGraphicsSettings({
      deviceDpr,
      effectiveDpr: dpr,
      maxDpr: quality.maxDpr,
      glow: quality.glow,
      source: quality.source,
      touchControls,
      cssWidth: width,
      cssHeight: height,
      backingWidth,
      backingHeight,
    });
    return backingSizeChanged || devicePixelRatioChanged;
  }

  private syncPlayfieldChrome(
    width: number,
    height: number,
    miniMap: { x: number; y: number; size: number },
    touchControls: boolean
  ): void {
    const chrome = this.canvas?.parentElement;
    if (!(chrome instanceof HTMLElement)) {
      return;
    }
    const offsets = playfieldToggleOffsets(miniMap, touchControls, height);
    const hud = hudLayoutForCanvas({ width, height });
    chrome.style.setProperty(
      '--mobile-controls-top',
      `${Math.max(hud.economyBottomY, hud.leaderboard.y + hud.leaderboard.rowHeight * hud.leaderboard.maxRows) + 12}px`
    );
    chrome.style.setProperty('--map-toggle-x', `${miniMap.x}px`);
    chrome.style.setProperty('--map-toggle-y', `${offsets.mapY}px`);
    chrome.style.setProperty('--schematic-toggle-y', `${offsets.schematicY}px`);
    chrome.style.setProperty('--store-toggle-y', `${offsets.storeY}px`);
    if (chrome.id !== 'gameArea') {
      return;
    }
    const cssWidth = `${width}px`;
    const cssHeight = `${height}px`;
    if (chrome.style.width !== cssWidth) {
      chrome.style.width = cssWidth;
    }
    if (chrome.style.height !== cssHeight) {
      chrome.style.height = cssHeight;
    }
  }

  private clearPlayfieldChrome(): void {
    const chrome = this.canvas?.parentElement;
    if (!(chrome instanceof HTMLElement) || chrome.id !== 'gameArea') {
      return;
    }
    chrome.style.removeProperty('width');
    chrome.style.removeProperty('height');
  }

  private handleCanvasResize(): void {
    if (this.canvas && this.context) {
      const changed = this.applyViewportSize();

      if (changed) {
        this.context.imageSmoothingEnabled = true;
        this.context.imageSmoothingQuality = 'high';
      }
    }
  }

  destroy(): void {
    this.clearPlayfieldChrome();
    this.stopDevicePixelRatioWatcher?.();
    this.stopDevicePixelRatioWatcher = null;
    if (this.resizeFrame !== null) {
      window.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      window.visualViewport?.removeEventListener('resize', this.resizeHandler);
      window.visualViewport?.removeEventListener('scroll', this.resizeHandler);
      for (const media of this.inputMediaQueries) {
        media.removeEventListener('change', this.resizeHandler);
      }
      this.resizeHandler = null;
    }
    this.inputMediaQueries = [];
    clientPerformance.setRendererObservation('canvas', null);
    this.gpuRenderer?.destroy();
    this.gpuRenderer = null;
    this.gpuFrameActive = false;
    this.canvas = null;
    this.context = null;
    this.viewport.width = 1;
    this.viewport.height = 1;
    this.devicePixelRatio = 1;
    this.cameraRotation = 0;
    this.zoom = 1;
    this.zoomUpdatedAt = null;
    this.worldLayersZoomed = false;
    configureRenderQuality('', false);
    clearHudLayoutCache();
  }

  getRendererBackend(): 'canvas' | 'webgl2' {
    return this.gpuFrameActive && this.gpuRenderer?.available() ? 'webgl2' : 'canvas';
  }

  getGpuFrameStats() {
    return this.gpuRenderer?.getStats() ?? null;
  }

  canDrawGpuRear(): boolean {
    return this.gpuRenderer?.available() ?? false;
  }

  drawGpuRear(scene: {
    position: Position;
    contours: readonly GpuContourLayer[];
    starTiles: readonly (readonly StarPoint[])[];
  }): boolean {
    const viewport = this.worldLayersZoomed ? this.screenViewport : this.viewport;
    this.gpuFrameActive = false;
    const ctx = this.requireContext();
    ctx.save();
    let contourTransform: DOMMatrix;
    try {
      this.applyWorldTransform(ctx, scene.position);
      contourTransform = ctx.getTransform();
    } finally {
      ctx.restore();
    }
    paintOpaqueBackground(ctx);
    const nativeStars = drawStarLayers(
      ctx,
      scene.starTiles,
      scene.position,
      this.viewport,
      PLAYFIELD_CLOSE_SCALE,
      this.cameraRotation
    );
    const drawn =
      this.gpuRenderer?.draw({
        position: scene.position,
        contours: scene.contours,
        rearSource: ctx.canvas,
        ...nativeStars,
        width: viewport.width,
        height: viewport.height,
        dpr: this.devicePixelRatio,
        scale: PLAYFIELD_CLOSE_SCALE,
        zoom: this.zoom,
        rotation: this.cameraRotation,
        contourTransform: {
          a: contourTransform.a,
          b: contourTransform.b,
          c: contourTransform.c,
          d: contourTransform.d,
        },
      }) ?? false;
    if (!drawn) {
      this.replayScanTransform(ctx);
    }
    return drawn;
  }

  composeGpuRear(context: CanvasRenderingContext2D): boolean {
    this.gpuFrameActive = this.gpuRenderer?.composeInto(context) ?? false;
    this.replayScanTransform(context);
    return this.gpuFrameActive;
  }

  private replayScanTransform(context: CanvasRenderingContext2D): void {
    if (this.worldLayersZoomed) {
      // A Canvas source snapshot can restart Chromium's native recorder from
      // its double DOM matrix, changing float concatenation rounding. Replay
      // the original scan operations so foreground painters see that same CTM.
      context.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
      this.applyScanTransform(context);
    }
  }

  requiresNativeGpuContours(): boolean {
    return this.gpuFrameActive && this.gpuRenderer?.getStats().contourMode === 'canvas-path';
  }

  recordNativeGpuContours(segments: number): void {
    if (this.gpuFrameActive) {
      this.gpuRenderer?.recordNativeContours(segments);
    }
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  getContext(): CanvasRenderingContext2D | null {
    return this.context;
  }

  getViewportSize(): Readonly<PlayfieldSize> {
    return this.viewport;
  }

  clearPlayfield(): void {
    const ctx = this.context;
    const canvas = this.canvas;
    if (!ctx || !canvas) {
      return;
    }
    paintOpaqueBackground(ctx);
  }

  requireCanvas(): HTMLCanvasElement {
    if (!this.canvas) {
      throw new Error('Canvas not initialized');
    }
    return this.canvas;
  }

  requireContext(): CanvasRenderingContext2D {
    if (!this.context) {
      throw new Error('Canvas context not initialized');
    }
    return this.context;
  }

  followTravel(ship: Parameters<typeof travelCameraRotation>[0]): void {
    this.cameraRotation = travelCameraRotation(ship);
  }

  getCameraRotation(): number {
    return this.cameraRotation;
  }

  /** Apply the same projection to painters that retain paths in world coordinates. */
  applyWorldTransform(ctx: CanvasRenderingContext2D, center: Position): void {
    const viewport = this.getViewportSize();
    const scale = this.getPlayfieldScale();
    ctx.translate(viewport.width / 2, viewport.height / 2);
    ctx.rotate(this.cameraRotation);
    ctx.scale(scale, scale);
    ctx.translate(-center.x, -center.y);
  }

  /** Ease the camera toward `target` (1 = flight view, below 1 = zoomed out) in log space. */
  easeZoomToward(target: number, now: number): void {
    const dtSeconds = this.zoomUpdatedAt === null ? 0 : (now - this.zoomUpdatedAt) / 1000;
    this.zoomUpdatedAt = now;
    const seconds = target < this.zoom ? CAMERA_ZOOM_OUT_SECONDS : CAMERA_ZOOM_IN_SECONDS;
    const blend = 1 - Math.exp(-Math.min(dtSeconds, 0.1) / seconds);
    const next = Math.exp(Math.log(this.zoom) + (Math.log(target) - Math.log(this.zoom)) * blend);
    this.zoom = Math.abs(next - target) < 0.002 ? target : next;
  }

  /**
   * World painters keep drawing at scale 1 into a larger virtual viewport; the context
   * transform shrinks it onto the real screen. Pair with `endWorldLayers` before the HUD.
   * The zoom is presentation only: update-time rules that read the viewport (laser reach,
   * contour capture, audio culling) deliberately stay at flight scale during a scan.
   */
  beginWorldLayers(ctx: CanvasRenderingContext2D): void {
    if (this.zoom === 1) {
      return;
    }
    this.worldLayersZoomed = true;
    this.screenViewport.width = this.viewport.width;
    this.screenViewport.height = this.viewport.height;
    this.viewport.width = this.screenViewport.width / this.zoom;
    this.viewport.height = this.screenViewport.height / this.zoom;
    ctx.save();
    this.applyScanTransform(ctx);
  }

  private applyScanTransform(ctx: CanvasRenderingContext2D): void {
    ctx.translate(this.screenViewport.width / 2, this.screenViewport.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.viewport.width / 2, -this.viewport.height / 2);
  }

  endWorldLayers(ctx: CanvasRenderingContext2D, painterFailed = false): void {
    if (this.worldLayersZoomed) {
      this.worldLayersZoomed = false;
      ctx.restore();
      this.viewport.width = this.screenViewport.width;
      this.viewport.height = this.screenViewport.height;
    }
    if (painterFailed) {
      // Frames start at the DPR transform established by applyViewportSize.
      // Restore it without querying Canvas state. Painters own balanced save
      // scopes on exceptions so their styles and clips also leave with them.
      ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
    }
  }

  getPlayfieldScale(): number {
    return PLAYFIELD_CLOSE_SCALE;
  }

  worldToScreenInto(
    out: { x: number; y: number },
    worldPos: Position,
    shipPos: Position
  ): { x: number; y: number } {
    const scale = PLAYFIELD_CLOSE_SCALE;
    if (!this.canvas) {
      rotateVectorInto(out, worldPos.x - shipPos.x, worldPos.y - shipPos.y, this.cameraRotation);
      out.x *= scale;
      out.y *= scale;
      return out;
    }
    return projectWorldToScreenInto(
      out,
      worldPos,
      shipPos,
      this.viewport,
      scale,
      this.cameraRotation
    );
  }

  worldToScreen(worldPos: Position, shipPos: Position): Point {
    const pos = this.worldToScreenInto(this.screenPos, worldPos, shipPos);
    return new Point(pos.x, pos.y);
  }

  screenToWorld(screenPos: Point, shipPos: Position): Position {
    const scale = PLAYFIELD_CLOSE_SCALE;
    const offset = rotateVectorInto(
      { x: 0, y: 0 },
      (screenPos.x - (this.canvas ? this.viewport.width / 2 : 0)) / scale,
      (screenPos.y - (this.canvas ? this.viewport.height / 2 : 0)) / scale,
      -this.cameraRotation
    );
    return { x: offset.x + shipPos.x, y: offset.y + shipPos.y };
  }
}

export const canvasManager = new CanvasManager();
