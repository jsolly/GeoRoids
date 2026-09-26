import type { Position } from '../../shared-types';
import { PALETTE } from '../constants';
import { clientPerformance } from '../diagnostics/performanceMetrics';
import { Point } from '../physics/Point';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { watchDevicePixelRatio } from './devicePixelRatioWatcher';
import { hudLayoutForCanvas } from './hud/hudLayout';
import {
  PLAYFIELD_CLOSE_SCALE,
  type PlayfieldSize,
  projectWorldToScreenInto,
} from './playfieldCamera';
import { configureRenderQuality } from './renderQuality';
import { rotateVectorInto, travelCameraRotation } from './travelCamera';

const TOGGLE_STEP_PX = 52;

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
  private readonly screenPos = { x: 0, y: 0 };

  initialize(): void {
    this.canvas = document.querySelector('#gameCanvas') as HTMLCanvasElement | null;
    this.context = this.canvas?.getContext('2d', { alpha: false }) || null;

    if (this.canvas && this.context) {
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

      this.stopDevicePixelRatioWatcher = watchDevicePixelRatio(() => {
        this.handleCanvasResize();
      });

      this.handleCanvasResize();
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

    const { miniMap } = hudLayoutForCanvas(this.viewport);
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
      this.resizeHandler = null;
    }
    this.canvas = null;
    this.context = null;
    this.viewport.width = 1;
    this.viewport.height = 1;
    this.devicePixelRatio = 1;
    this.cameraRotation = 0;
    configureRenderQuality('', false);
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
    ctx.fillStyle = PALETTE.BG;
    ctx.fillRect(0, 0, this.viewport.width, this.viewport.height);
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
