/**
 * Optimized Rendering Engine
 * Consolidates and optimizes the rendering pipeline for better performance
 */

import { AuthoritativeProjectileField } from '../entities/laser/AuthoritativeProjectileField';
import type { Player } from '../entities/player/Player';
import type { RoidBelt } from '../entities/roid/Roid';
import { drawRoidsRelative } from '../entities/roid/roidRenderer';
import type { Ship } from '../entities/ship/Ship';
import {
  drawLasers,
  drawShipAtPosition,
  drawShipExplosion,
  drawShipExplosionAtPosition,
  drawThrusterAtPosition,
} from '../entities/ship/shipRenderer';
import { shouldDrawShipHull } from '../entities/ship/shipUtils';
import { GameError } from '../types';
import { errorHandler } from '../utils/ErrorHandler';
import { logger } from '../utils/Logger';
import { drawFieryBoundary } from './boundaryRenderer';
import { canvasManager } from './canvas';
import { drawDebugInfo, drawScoreOverlay, drawTextOverlay } from './hud/gameInfo';
import { drawLeaderboard } from './hud/leaderboard';
import { drawLivesIndicator } from './hud/lives';
import { drawMiniMap } from './hud/minimap';

export interface RenderFrame {
  readonly player: Player;
  readonly roidBelt: RoidBelt;
  readonly score: number;
  readonly textAlpha: number;
  readonly text: string;
  readonly lives: number;
  readonly allPlayers: readonly Player[];
  readonly showLeaderboard: boolean;
  readonly showMinimap: boolean;
  readonly debugMode: boolean;
}

export interface RenderStats {
  frameTime: number;
  drawCalls: number;
  entitiesDrawn: number;
  performanceIssues: string[];
}

/**
 * High-performance rendering engine with batching and optimization
 */
export class RenderEngine {
  private static instance: RenderEngine;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private renderStats: RenderStats;
  private performanceThreshold = 16; // 60 FPS threshold in ms
  private frameCount = 0;
  private frameTimeHistory: number[] = [];
  private readonly MAX_FRAME_HISTORY = 60; // Keep last 60 frames for averaging (1 second at 60 FPS)

  private constructor() {
    this.renderStats = {
      frameTime: 0,
      drawCalls: 0,
      entitiesDrawn: 0,
      performanceIssues: [],
    };
  }

  static getInstance(): RenderEngine {
    if (!RenderEngine.instance) {
      RenderEngine.instance = new RenderEngine();
    }
    return RenderEngine.instance;
  }

  /**
   * Initialize the rendering engine
   */
  initialize(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', {
      alpha: false, // Disable alpha for better performance
      desynchronized: true, // Reduce latency
    });

    if (this.ctx) {
      // Enable high-performance rendering settings
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.imageSmoothingQuality = 'high';

      // Set up performance monitoring
      this.setupPerformanceMonitoring();
    }

    logger.info('RENDER_ENGINE', 'RenderEngine initialized', {
      canvasSize: { width: canvas.width, height: canvas.height },
    });
  }

  /**
   * Render a complete game frame
   */
  renderFrame(frame: RenderFrame): void {
    if (!this.ctx || !this.canvas) {
      logger.warn('RENDER_ENGINE', 'RenderEngine not initialized');
      return;
    }

    const startTime = performance.now();

    try {
      this.resetFrameStats();

      // Clear canvas with optimized method
      this.clearCanvas();
      canvasManager.beginPlayfieldFrame(frame.player.ship.position, frame.roidBelt.getRoids());

      // Render game world in order of depth (back to front)
      this.renderBackground(frame);
      this.renderEntities(frame);
      this.renderEffects(frame);
      this.renderUI(frame);

      // Update performance stats
      const frameTime = performance.now() - startTime;
      this.updatePerformanceStats(frameTime);

      this.frameCount++;
    } catch (error) {
      const gameError =
        error instanceof GameError
          ? error
          : new GameError(error instanceof Error ? error.message : String(error), 'RENDER_ERROR');
      errorHandler.handleGameError(gameError, 'RENDER_ENGINE');
    }
  }

  /**
   * Get current render statistics
   */
  getRenderStats(): RenderStats {
    return { ...this.renderStats };
  }

  /**
   * Reset performance statistics
   */
  resetStats(): void {
    this.renderStats = {
      frameTime: 0,
      drawCalls: 0,
      entitiesDrawn: 0,
      performanceIssues: [],
    };
    this.frameCount = 0;
  }

  // Private rendering methods
  private clearCanvas(): void {
    if (this.ctx && this.canvas) {
      // Use clearRect for better performance than fillRect
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.renderStats.drawCalls++;
    }
  }

  private renderBackground(frame: RenderFrame): void {
    // Render boundary effect
    drawFieryBoundary(frame.player.ship.position);
    this.renderStats.drawCalls++;
  }

  private renderEntities(frame: RenderFrame): void {
    const { player, roidBelt, allPlayers } = frame;

    // Batch roid rendering
    const roids = roidBelt.getRoids();
    if (roids.length > 0) {
      drawRoidsRelative(player.ship, roids);
      this.renderStats.drawCalls++;
      this.renderStats.entitiesDrawn += roids.length;
    }

    // Batch player rendering with culling optimization
    this.renderPlayers(allPlayers, player.ship);
  }

  private renderPlayers(allPlayers: readonly Player[], localShip: Ship): void {
    // Cache local player reference for efficient lookup
    const localPlayer = allPlayers.find((p) => p.type === 'local');

    for (const player of allPlayers) {
      if (player.ship.exploding) {
        if (player.id === localPlayer?.id) {
          drawShipExplosion(player.ship, player.ship.color);
        } else {
          drawShipExplosionAtPosition(player.ship, localShip.position, player.ship.color);
        }
      } else if (shouldDrawShipHull(player.ship)) {
        drawShipAtPosition(
          player.ship,
          localShip.position,
          player.ship.color,
          player.name,
          player.factionId
        );
      }

      if (
        shouldDrawShipHull(player.ship) &&
        player.ship.thrusting &&
        localPlayer &&
        player.id !== localPlayer.id
      ) {
        drawThrusterAtPosition(player.ship, localShip.position);
      }

      this.renderStats.drawCalls += 2; // Ship + thruster
      this.renderStats.entitiesDrawn++;
    }
  }

  private renderEffects(frame: RenderFrame): void {
    const { player, allPlayers } = frame;

    const projectileField = AuthoritativeProjectileField.getInstance();
    if (projectileField.isEnabled()) {
      projectileField.draw(player.ship.position);
      this.renderStats.drawCalls++;
      return;
    }

    // Render lasers for all ships
    drawLasers(player.ship);
    this.renderStats.drawCalls++;

    // Render other players' lasers
    for (const otherPlayer of allPlayers) {
      // Skip rendering lasers for players who are exploding (truly dead)
      if (otherPlayer.id !== player.id && !otherPlayer.ship.exploding) {
        drawLasers(otherPlayer.ship, otherPlayer.ship.color, player.ship.position);
        this.renderStats.drawCalls++;
      }
    }
  }

  private renderUI(frame: RenderFrame): void {
    if (!this.ctx || !this.canvas) {
      return;
    }

    const {
      score,
      textAlpha,
      text,
      lives,
      allPlayers,
      player,
      showLeaderboard,
      showMinimap,
      debugMode,
    } = frame;

    // Render HUD elements
    drawScoreOverlay(this.ctx, this.canvas, score, lives, player.factionId);
    drawLivesIndicator(this.ctx, lives, player.ship.color, player.ship.kitId);

    if (text && textAlpha > 0) {
      drawTextOverlay(this.ctx, this.canvas, text, textAlpha);
    }

    if (showLeaderboard && allPlayers.length > 1) {
      drawLeaderboard(this.ctx, this.canvas, [...allPlayers], player.id);
    }

    if (showMinimap) {
      drawMiniMap(this.ctx, this.canvas, player.ship);
    }

    // Render debug information
    const roidCount = frame.roidBelt.roids.length;
    drawDebugInfo(this.ctx, this.canvas, roidCount, debugMode);

    this.renderStats.drawCalls += 4; // Base HUD elements
  }

  private resetFrameStats(): void {
    this.renderStats.drawCalls = 0;
    this.renderStats.entitiesDrawn = 0;
    this.renderStats.performanceIssues = [];
  }

  private updatePerformanceStats(frameTime: number): void {
    // Update frame time history
    this.frameTimeHistory.push(frameTime);

    // Keep only the most recent frames
    if (this.frameTimeHistory.length > this.MAX_FRAME_HISTORY) {
      this.frameTimeHistory.shift();
    }

    // Calculate true average frame time from history
    const avgFrameTime =
      this.frameTimeHistory.length > 0
        ? this.frameTimeHistory.reduce((sum, time) => sum + time, 0) / this.frameTimeHistory.length
        : frameTime;

    // Update render stats with current frame time (for immediate feedback)
    this.renderStats.frameTime = frameTime;

    // Check for performance issues
    if (frameTime > this.performanceThreshold) {
      this.renderStats.performanceIssues.push(`Frame took ${frameTime.toFixed(2)}ms`);
    }

    // Log performance warnings periodically using true average
    if (this.frameCount % 300 === 0) {
      // Every 5 seconds at 60 FPS
      if (avgFrameTime > this.performanceThreshold) {
        logger.warn('RENDER_ENGINE', 'Performance issue detected', {
          avgFrameTime: avgFrameTime.toFixed(2),
          currentFrameTime: frameTime.toFixed(2),
          drawCalls: this.renderStats.drawCalls,
          entitiesDrawn: this.renderStats.entitiesDrawn,
        });
      }
    }
  }

  private setupPerformanceMonitoring(): void {
    // Monitor canvas context loss
    if (this.canvas) {
      this.canvas.addEventListener('contextlost', (event) => {
        event.preventDefault();
        logger.error('RENDER_ENGINE', 'Canvas context lost');
      });

      this.canvas.addEventListener('contextrestored', () => {
        logger.info('RENDER_ENGINE', 'Canvas context restored');
        if (this.canvas) {
          this.initialize(this.canvas);
        }
      });
    }
  }

  /**
   * Get rendering capabilities info
   */
  getCapabilities(): {
    webgl: boolean;
    webgl2: boolean;
    maxTextureSize: number;
    renderer: string;
  } {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    const gl2 = canvas.getContext('webgl2');

    return {
      webgl: !!gl,
      webgl2: !!gl2,
      maxTextureSize:
        gl && gl instanceof WebGLRenderingContext ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0,
      renderer:
        gl && gl instanceof WebGLRenderingContext
          ? (gl.getParameter(gl.RENDERER) as string)
          : 'unknown',
    };
  }
}

// Export singleton instance
export const renderEngine = RenderEngine.getInstance();

// Convenience functions
export const render = {
  initialize: (canvas: HTMLCanvasElement) => renderEngine.initialize(canvas),
  frame: (frame: RenderFrame) => renderEngine.renderFrame(frame),
  getStats: () => renderEngine.getRenderStats(),
  resetStats: () => renderEngine.resetStats(),
  getCapabilities: () => renderEngine.getCapabilities(),
};
