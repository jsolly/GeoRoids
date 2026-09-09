import type { Position } from '../../shared-types';
import { PALETTE } from '../constants';
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
import { hudLayoutForCanvas } from './hud/hudLayout';
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
    return projectWorldToScreenInto(out, worldPos, shipPos, this.canvas, scale);
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
      x: (screenPos.x - this.canvas.width / 2) / scale + shipPos.x,
      y: (screenPos.y - this.canvas.height / 2) / scale + shipPos.y,
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
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw roids
    const roids = currRoidBelt.getRoids();

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

    const hudLayout = hudLayoutForCanvas(canvas);
    drawMiniMap(ctx, hudLayout, currShip);

    drawScoreOverlay(ctx, hudLayout, canvas, currScore, lives, currPlayer.factionId);

    drawLivesIndicator(ctx, hudLayout, lives, PALETTE.LOCAL, currShip.kitId);

    if (text && textAlpha > 0) {
      drawTextOverlay(ctx, hudLayout, canvas, text, textAlpha);
    }

    if (allPlayers.length > 1) {
      drawLeaderboard(ctx, hudLayout, allPlayers, currPlayer.id);
    }

    const roidCount = currRoidBelt.roids.length;
    drawDebugInfo(ctx, canvas, roidCount, isDebugMode());
  }
}

// Singleton instance
const canvasManager = new CanvasManager();

// Export the singleton instance
export { canvasManager };
