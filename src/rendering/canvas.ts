import type { Position } from '../../shared-types';
import { PALETTE } from '../constants';
import {
  CANVAS_DEFAULT_CENTER_X,
  CANVAS_DEFAULT_CENTER_Y,
  CANVAS_INTERNAL_HEIGHT,
  CANVAS_INTERNAL_WIDTH,
} from '../constants/canvas';
import { LootField } from '../entities/loot/LootField';
import { drawLootRelative } from '../entities/loot/lootRenderer';
import type { Player } from '../entities/player/Player';
import type { RoidBelt } from '../entities/roid/Roid';
import { drawRoidsRelative } from '../entities/roid/roidRenderer';
import { SatelliteManager } from '../entities/satellite/SatelliteManager';
import { drawSatellites } from '../entities/satellite/satelliteRenderer';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import { drawSatellitePickups } from '../entities/satellitePickup/satellitePickupRenderer';
import type { Ship } from '../entities/ship/Ship';
import {
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
import { getFactionColor, getLaserColor } from '../utils/colorUtils';
import { isDebugMode } from '../utils/debugUtils';
import { drawFieryBoundary } from './boundaryRenderer';
import {
  drawContourLaserTicks,
  type LiveLaserSource,
  liveLaserPositions,
} from './contourLaserRenderer';
import { drawIsoContours } from './contourRenderer';
import { drawDebugInfo, drawScoreOverlay, drawTextOverlay } from './hud/gameInfo';
import { drawLeaderboard } from './hud/leaderboard';
import { drawLivesIndicator } from './hud/lives';
import { drawMiniMap } from './hud/minimap';
import { PLAYFIELD_CLOSE_SCALE, projectWorldToScreenInto } from './playfieldCamera';
import { drawShockwaves } from './shockwaveRenderer';
import { drawStarfield } from './starfield';

// Canvas manager class for handling dynamic canvas operations and game rendering
class CanvasManager {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private resizeHandler: (() => void) | null = null;
  private playfieldScale = 1;
  private readonly screenPos = { x: 0, y: 0 };
  private readonly laserHosts: LiveLaserSource[] = [{ lasers: [] }];
  private readonly liveLaserPositions: Position[] = [];

  // Initialize canvas with proper scaling
  initialize(): void {
    this.canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;
    this.context = this.canvas?.getContext('2d', { alpha: false }) || null;

    if (this.canvas && this.context) {
      this.applyViewportSize();

      // Enable crisp pixel rendering
      this.context.imageSmoothingEnabled = true;
      this.context.imageSmoothingQuality = 'high';

      // Add resize handler to maintain full-screen coverage
      this.resizeHandler = this.handleCanvasResize.bind(this);
      window.addEventListener('resize', this.resizeHandler);
      window.visualViewport?.addEventListener('resize', this.resizeHandler);
      window.visualViewport?.addEventListener('scroll', this.resizeHandler);

      // Initial resize call
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

  private applyViewportSize(): void {
    if (!this.canvas) {
      return;
    }
    const { width, height } = this.viewportSize();
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  // Handle canvas resizing to maintain full-screen coverage
  private handleCanvasResize(): void {
    if (this.canvas && this.context) {
      this.applyViewportSize();

      // Re-enable crisp rendering after resize
      this.context.imageSmoothingEnabled = true;
      this.context.imageSmoothingQuality = 'high';
    }
  }

  // Cleanup method
  destroy(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      window.visualViewport?.removeEventListener('resize', this.resizeHandler);
      window.visualViewport?.removeEventListener('scroll', this.resizeHandler);
      this.resizeHandler = null;
    }
    this.canvas = null;
    this.context = null;
  }

  // Safe accessor methods for canvas and context
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  getContext(): CanvasRenderingContext2D | null {
    return this.context;
  }

  clearPlayfield(): void {
    const ctx = this.context;
    const canvas = this.canvas;
    if (!ctx || !canvas) {
      return;
    }
    ctx.fillStyle = PALETTE.BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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

  // Coordinate scaling utilities for dynamic canvas sizes
  getScaleX(): number {
    return this.canvas ? this.canvas.width / CANVAS_INTERNAL_WIDTH : 1;
  }

  getScaleY(): number {
    return this.canvas ? this.canvas.height / CANVAS_INTERNAL_HEIGHT : 1;
  }

  scaleX(x: number): number {
    return x * this.getScaleX();
  }

  scaleY(y: number): number {
    return y * this.getScaleY();
  }

  getCanvasCenter(): { x: number; y: number } {
    return {
      x: this.canvas ? this.canvas.width / 2 : CANVAS_DEFAULT_CENTER_X,
      y: this.canvas ? this.canvas.height / 2 : CANVAS_DEFAULT_CENTER_Y,
    };
  }

  beginPlayfieldFrame(
    _shipPos: Position,
    _roids: ReadonlyArray<{ position: Position; r?: number }>
  ): void {
    if (!this.canvas) {
      this.playfieldScale = PLAYFIELD_CLOSE_SCALE;
      return;
    }
    this.playfieldScale = PLAYFIELD_CLOSE_SCALE;
  }

  getPlayfieldScale(): number {
    return this.playfieldScale;
  }

  worldToScreenInto(
    out: { x: number; y: number },
    worldPos: Position,
    shipPos: Position
  ): { x: number; y: number } {
    const scale = this.playfieldScale;
    if (!this.canvas) {
      out.x = (worldPos.x - shipPos.x) * scale;
      out.y = (worldPos.y - shipPos.y) * scale;
      return out;
    }
    return projectWorldToScreenInto(out, worldPos, shipPos, this.canvas, scale);
  }

  // Viewport transformation methods
  worldToScreen(worldPos: Position, shipPos: Position): Point {
    const pos = this.worldToScreenInto(this.screenPos, worldPos, shipPos);
    return new Point(pos.x, pos.y);
  }

  screenToWorld(screenPos: Point, shipPos: Position): Position {
    const scale = this.playfieldScale || 1;
    if (!this.canvas) {
      return { x: screenPos.x / scale + shipPos.x, y: screenPos.y / scale + shipPos.y };
    }

    return {
      x: (screenPos.x - this.canvas.width / 2) / scale + shipPos.x,
      y: (screenPos.y - this.canvas.height / 2) / scale + shipPos.y,
    };
  }

  isWorldPositionVisible(worldPos: Position, shipPos: Position, margin: number = 100): boolean {
    if (!this.canvas) {
      // Fallback to true if canvas is not available
      return true;
    }

    const screenPos = this.worldToScreenInto(this.screenPos, worldPos, shipPos);
    return (
      screenPos.x >= -margin &&
      screenPos.x <= this.canvas.width + margin &&
      screenPos.y >= -margin &&
      screenPos.y <= this.canvas.height + margin
    );
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
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw roids
    const roids = currRoidBelt.getRoids();
    this.beginPlayfieldFrame(currShip.position, roids);

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

    this.drawMiniMapWithPlayers(currShip);

    drawScoreOverlay(ctx, canvas, currScore, lives, currPlayer.factionId);

    drawLivesIndicator(ctx, lives, PALETTE.LOCAL, currShip.kitId);

    if (text && textAlpha > 0) {
      drawTextOverlay(ctx, canvas, text, textAlpha);
    }

    if (allPlayers.length > 1) {
      drawLeaderboard(ctx, canvas, allPlayers, currPlayer.id);
    }

    const roidCount = currRoidBelt.roids.length;
    drawDebugInfo(ctx, canvas, roidCount, isDebugMode());
  }

  // Helper method to draw mini map with all players
  private drawMiniMapWithPlayers(ship: Ship): void {
    // Draw the base mini map
    const ctx = this.getContext();
    const canvas = this.getCanvas();
    if (ctx && canvas) {
      drawMiniMap(ctx, canvas, ship);
    }

    // The mini map module will handle drawing all players internally
  }
}

// Singleton instance
const canvasManager = new CanvasManager();

// Export the singleton instance
export { canvasManager };
