import type { Position } from '../../shared-types';
import { PALETTE } from '../constants';
import { clientPerformance } from '../diagnostics/performanceMetrics';
import { LootField } from '../entities/loot/LootField';
import { drawLootRelative } from '../entities/loot/lootRenderer';
import type { Player } from '../entities/player/Player';
import type { RoidBelt } from '../entities/roid/Roid';
import { drawRoidsRelative } from '../entities/roid/roidRenderer';
import { SatelliteManager } from '../entities/satellite/SatelliteManager';
import { drawSatellites } from '../entities/satellite/satelliteRenderer';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import { drawSatellitePickups } from '../entities/satellitePickup/satellitePickupRenderer';
import {
  drawHaulerHarpoonRelative,
  drawLasers,
  drawShipAtPosition,
  drawShipExplosion,
  drawShipExplosionAtPosition,
  drawThruster,
  drawThrusterAtPosition,
} from '../entities/ship/shipRenderer';
import { shouldDrawShipHull } from '../entities/ship/shipUtils';
import { NetworkManager } from '../network/networkManager';
import { Point } from '../physics/Point';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { getFactionColor, getLaserColor } from '../utils/colorUtils';
import { isDebugMode } from '../utils/debugUtils';
import { drawFieryBoundary } from './boundaryRenderer';
import {
  drawContourLaserTicks,
  type LiveLaserSource,
  liveLaserPositions,
} from './contourLaserRenderer';
import { drawIsoContours } from './contourRenderer';
import { watchDevicePixelRatio } from './devicePixelRatioWatcher';
import { drawDebugInfo, drawScoreOverlay, drawTextOverlay } from './hud/gameInfo';
import { hudLayoutForCanvas } from './hud/hudLayout';
import { drawLeaderboard } from './hud/leaderboard';
import { drawLivesIndicator } from './hud/lives';
import { drawMiniMap } from './hud/minimap';
import {
  PLAYFIELD_CLOSE_SCALE,
  type PlayfieldSize,
  projectWorldToScreenInto,
} from './playfieldCamera';
import { configureRenderQuality } from './renderQuality';
import { drawShockwaves } from './shockwaveRenderer';
import { drawStarfield } from './starfield';

// Canvas manager class for handling dynamic canvas operations and game rendering
class CanvasManager {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private resizeHandler: (() => void) | null = null;
  private resizeFrame: number | null = null;
  private stopDevicePixelRatioWatcher: (() => void) | null = null;
  private readonly viewport = { width: 1, height: 1 };
  private devicePixelRatio = 1;
  private readonly screenPos = { x: 0, y: 0 };
  private readonly laserHosts: LiveLaserSource[] = [{ lasers: [] }];
  private readonly liveLaserPositions: Position[] = [];

  // Initialize canvas with proper scaling
  initialize(): void {
    this.canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;
    this.context = this.canvas?.getContext('2d', { alpha: false }) || null;

    if (this.canvas && this.context) {
      // Add resize handler to maintain full-screen coverage
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

      // Run the same boundary used for later resizes once at startup.
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

  // Handle canvas resizing to maintain full-screen coverage
  private handleCanvasResize(): void {
    if (this.canvas && this.context) {
      const changed = this.applyViewportSize();

      // Re-enable crisp rendering after resize
      if (changed) {
        this.context.imageSmoothingEnabled = true;
        this.context.imageSmoothingQuality = 'high';
      }
    }
  }

  // Cleanup method
  destroy(): void {
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
    configureRenderQuality('', false);
  }

  // Safe accessor methods for canvas and context
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
      out.x = (worldPos.x - shipPos.x) * scale;
      out.y = (worldPos.y - shipPos.y) * scale;
      return out;
    }
    return projectWorldToScreenInto(out, worldPos, shipPos, this.viewport, scale);
  }

  // Viewport transformation methods
  worldToScreen(worldPos: Position, shipPos: Position): Point {
    const pos = this.worldToScreenInto(this.screenPos, worldPos, shipPos);
    return new Point(pos.x, pos.y);
  }

  screenToWorld(screenPos: Point, shipPos: Position): Position {
    const scale = PLAYFIELD_CLOSE_SCALE;
    if (!this.canvas) {
      return { x: screenPos.x / scale + shipPos.x, y: screenPos.y / scale + shipPos.y };
    }

    return {
      x: (screenPos.x - this.viewport.width / 2) / scale + shipPos.x,
      y: (screenPos.y - this.viewport.height / 2) / scale + shipPos.y,
    };
  }

  // Game rendering method that draws all game elements
  drawGame(
    currPlayer: Player,
    currRoidBelt: RoidBelt,
    currScore: number,
    textAlpha: number,
    text: string,
    lives: number,
    allPlayers: Player[]
  ): void {
    const currShip = currPlayer.ship;
    const ctx = this.getContext();
    const canvas = this.getCanvas();

    if (!ctx || !canvas) {
      return;
    }

    // Clear the canvas
    ctx.fillStyle = PALETTE.BG;
    ctx.fillRect(0, 0, this.viewport.width, this.viewport.height);

    const roids = currRoidBelt.getRoids();
    const viewport = this.getViewportSize();

    drawStarfield(currShip.position);
    drawIsoContours(currShip.position);

    const localId = NetworkManager.getInstance().getLocalPlayerId();
    let laserHostCount = 1;
    const localLaserHost = this.laserHosts[0];
    if (localLaserHost) {
      localLaserHost.lasers = currShip.lasers;
    }
    for (const player of allPlayers) {
      if (player.id !== localId && shouldDrawShipHull(player.ship)) {
        const host = this.laserHosts[laserHostCount];
        if (host) {
          host.lasers = player.ship.lasers;
        } else {
          this.laserHosts.push({ lasers: player.ship.lasers });
        }
        laserHostCount++;
      }
    }
    this.laserHosts.length = laserHostCount;
    drawContourLaserTicks(
      currShip.position,
      liveLaserPositions(this.laserHosts, this.liveLaserPositions)
    );

    // Draw fiery boundary using actual ship position for proper world coordinates
    drawFieryBoundary(currShip.position);

    if (roids.length > 0) {
      drawRoidsRelative(currShip, roids);
    }

    drawLootRelative(currShip, LootField.getInstance().getAll());
    drawSatellites(SatelliteManager.getInstance().getAll(), currShip.position);
    drawSatellitePickups(SatellitePickupManager.getInstance().getAll(), currShip.position);

    const localLaserColor = getLaserColor(true);
    const enemyLaserColor = getLaserColor(false);

    // Cable first — a dying or blinking hull must not hide the cream tether.
    for (const player of allPlayers) {
      const isLocal = player.id === localId;
      const ship = isLocal ? currShip : player.ship;
      drawHaulerHarpoonRelative(ship, currShip.position);
    }

    for (const player of allPlayers) {
      const factionColor = getFactionColor(player.type);
      const isLocal = player.id === localId;
      const ship = isLocal ? currShip : player.ship;

      if (ship.exploding) {
        if (isLocal) {
          drawShipExplosion(currShip, factionColor);
        } else {
          drawShipExplosionAtPosition(ship, currShip.position, factionColor);
        }
      } else if (shouldDrawShipHull(ship)) {
        drawShipAtPosition(
          ship,
          currShip.position,
          factionColor,
          isLocal ? currPlayer.name : player.name,
          player.factionId
        );
      }
    }

    for (const player of allPlayers) {
      const isLocal = player.id === localId;
      const ship = isLocal ? currShip : player.ship;
      if (!shouldDrawShipHull(ship) || !ship.thrusting) {
        continue;
      }
      const factionColor = getFactionColor(player.type);
      if (isLocal) {
        drawThruster(currShip, factionColor);
      } else {
        drawThrusterAtPosition(ship, currShip.position, factionColor);
      }
    }

    drawShockwaves(currShip.position);

    drawLasers(currShip, localLaserColor);

    for (const player of allPlayers) {
      if (player.id === localId || !shouldDrawShipHull(player.ship)) {
        continue;
      }
      drawLasers(player.ship, enemyLaserColor, currShip.position);
    }

    const hudLayout = hudLayoutForCanvas(viewport);
    drawMiniMap(ctx, hudLayout, currShip);

    drawScoreOverlay(ctx, hudLayout, viewport, currScore, lives, currPlayer.factionId);

    drawLivesIndicator(ctx, hudLayout, lives, PALETTE.LOCAL, currShip.kitId);

    if (text && textAlpha > 0) {
      drawTextOverlay(ctx, hudLayout, viewport, text, textAlpha);
    }

    if (allPlayers.length > 1) {
      drawLeaderboard(ctx, hudLayout, allPlayers, currPlayer.id);
    }

    const roidCount = currRoidBelt.roids.length;
    drawDebugInfo(ctx, viewport, roidCount, isDebugMode());
  }
}

// Singleton instance
const canvasManager = new CanvasManager();

// Export the singleton instance
export { canvasManager };
